import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readInbox, parseInboxCursor } from "../lib/inquiries/inbox.ts";

const file = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
test("creator inbox RPCs enforce actual PostgreSQL ownership and least privilege", async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  for (const name of ["20261119000100_creator_profiles", "20261119000200_public_creator_profiles", "20261119000300_collaboration_inquiries", "20261120000100_inquiry_retention", "20261120000200_creator_inbox"]) {
    await db.exec(file(`supabase/migrations/${name}.sql`));
  }
  for (const [id, slug] of [[a,"creator-a"],[b,"creator-b"],[c,"creator-c"]]) {
    await db.query("insert into auth.users values ($1)",[id]);
    await db.query("insert into creator_profiles(user_id,display_name,slug) values ($1,'Creator',$2)",[id,slug]);
  }
  await db.query(`insert into collabflow_private.collaboration_inquiries
    (id,creator_public_id,sender_name,sender_email,company,message,created_at)
    select ('aaaaaaaa-aaaa-4aaa-8aaa-'||lpad(n::text,12,'0'))::uuid, p.public_id,
      'Sender A','a@example.test','Brand',btrim(repeat('A private proposal. ',30)),'2026-11-20T06:00:00.123456Z'
    from public.creator_profiles p cross join generate_series(1,25) n where p.user_id=$1`,[a]);
  const aId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000025";
  const bId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
  await db.query(`insert into collabflow_private.collaboration_inquiries(id,creator_public_id,sender_name,sender_email,message)
    select $1,public_id,'Sender B','b@example.test','A private proposal from B' from creator_profiles where user_id=$2`,[bId,b]);
  async function as(user, query, params=[], role="authenticated") {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user??""]);
      assert.ok(["anon","authenticated","collabflow_inquiry_writer","collabflow_maintenance"].includes(role));
      await db.exec(`set local role ${role}`);
      return await db.query(query,params);
    } finally { await db.exec("rollback"); }
  }
  await t.test("A and B see only their own inquiries, including direct SELECT under RLS",async()=>{
    const first=(await as(a,"select * from public.list_creator_inquiries()")).rows;
    assert.equal(first.length,21); assert.ok(first.every(r=>r.sender_name==="Sender A"));
    assert.deepEqual(Object.keys(first[0]).sort(),["id","sender_name","company","created_at","message_preview"].sort());
    assert.equal(first[0].message_preview.length,240);
    assert.equal((await as(b,"select * from public.list_creator_inquiries()")).rows.length,1);
    assert.equal((await as(a,"select * from public.get_creator_inquiry($1)",[aId])).rows[0].sender_email,"a@example.test");
    assert.deepEqual((await as(b,"select * from public.get_creator_inquiry($1)",[aId])).rows,[]);
    assert.deepEqual((await as(a,"select * from public.get_creator_inquiry($1)",[bId])).rows,[]);
    const foreign=(await db.query("select public_id from creator_profiles where user_id=$1",[a])).rows[0].public_id;
    assert.deepEqual((await as(b,"select id,message from collabflow_private.collaboration_inquiries where creator_public_id=$1",[foreign])).rows,[]);
    assert.equal((await as(b,"select id from collabflow_private.collaboration_inquiries")).rows.length,1);
  });
  await t.test("anonymous/no identity denied; forged owner arguments have no matching function",async()=>{
    for(const role of ["anon","authenticated"]){
      await assert.rejects(as(null,"select * from public.list_creator_inquiries()",[],role),e=>e.code==="42501");
      await assert.rejects(as(null,"select * from public.get_creator_inquiry($1)",[aId],role),e=>e.code==="42501");
    }
    await assert.rejects(as(b,"select * from public.list_creator_inquiries(p_creator_id=>$1::uuid)",[a]),e=>e.code==="42883");
    await assert.rejects(as(null,"select id from collabflow_private.collaboration_inquiries",[],"anon"),e=>e.code==="42501");
    assert.deepEqual((await as(null,"select id from collabflow_private.collaboration_inquiries")).rows,[]);
  });
  await t.test("keyset pagination is bounded, deterministic with tied timestamps, and owner-safe",async()=>{
    const first=(await as(a,"select *,created_at::text as cursor_time from public.list_creator_inquiries(null,null,20)")).rows;
    assert.equal(first.length,20); assert.equal(first[0].id,aId);
    const last=first.at(-1);
    const next=(await as(a,"select * from public.list_creator_inquiries($1,$2,20)",[last.cursor_time,last.id])).rows;
    assert.equal(next.length,5);
    assert.equal(new Set([...first,...next].map(r=>r.id)).size,25);
    assert.deepEqual((await as(c,"select * from public.list_creator_inquiries()")).rows,[]);
    const forged=(await as(b,"select * from public.list_creator_inquiries($1,$2,21)",[last.cursor_time,last.id])).rows;
    assert.ok(forged.every(r=>r.sender_name==="Sender B"));
    for(const limit of [null,0,-1,22,100000])await assert.rejects(as(a,"select * from public.list_creator_inquiries(null,null,$1)",[limit]),e=>e.code==="22023");
    await assert.rejects(as(a,"select * from public.list_creator_inquiries(now(),null,21)"),e=>e.code==="22023");
    await assert.rejects(as(a,"select * from public.list_creator_inquiries('infinity',$1,21)",[aId]),e=>e.code==="22023");
  });
  await t.test("reader pagination retains adjacent microseconds and equivalent timezone offsets",async()=>{
    await db.query(`insert into collabflow_private.collaboration_inquiries
      (id,creator_public_id,sender_name,sender_email,message,created_at)
      select ('cccccccc-cccc-4ccc-8ccc-'||lpad(n::text,12,'0'))::uuid,p.public_id,
        'Sender C','c@example.test','Microsecond pagination proposal',
        '2024-03-01T00:00:00.123000+05:45'::timestamptz + n * interval '1 microsecond'
      from creator_profiles p cross join generate_series(1,25) n where p.user_id=$1`,[c]);
    const client={
      auth:{async getUser(){return {data:{user:{id:c}},error:null};}},
      from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{user_id:c},error:null};}};},
      async rpc(name,args){
        assert.equal(name,"list_creator_inquiries");
        // JSON serialization preserves the actual PostgREST timestamp shape,
        // unlike PGlite's default JS Date conversion of timestamptz columns.
        const result=await as(c,`select row_to_json(r) as item
          from public.list_creator_inquiries($1,$2,$3) r`,
          [args.p_before_created_at,args.p_before_id,args.p_limit]);
        return {data:result.rows.map(r=>r.item),error:null};
      },
    };
    const first=await readInbox(client,{});
    assert.equal(first.status,"ready");assert.equal(first.items.length,20);
    const boundary=parseInboxCursor(first.nextCursor);
    assert.equal(boundary.created_at,"2024-02-29T18:15:00.123006+00:00");
    const next=await readInbox(client,{cursor:first.nextCursor});
    assert.equal(next.status,"ready");assert.equal(next.items.length,5);assert.equal(next.nextCursor,null);
    const ids=[...first.items,...next.items].map(r=>r.id);
    assert.equal(new Set(ids).size,25);
    assert.deepEqual(ids,Array.from({length:25},(_,n)=>`cccccccc-cccc-4ccc-8ccc-${String(25-n).padStart(12,"0")}`));
    const offsetCursor=Buffer.from(JSON.stringify({...boundary,created_at:"2024-03-01T00:00:00.123006+05:45"})).toString("base64url");
    assert.deepEqual(await readInbox(client,{cursor:offsetCursor}),next);
  });
  await t.test("read-only grants preserve FORCE RLS, private metadata and cleanup restrictions",async()=>{
    const functions=(await db.query("select prosecdef,provolatile,proconfig from pg_proc where proname in ('list_creator_inquiries','get_creator_inquiry')")).rows;
    assert.equal(functions.length,2); assert.ok(functions.every(f=>!f.prosecdef&&f.provolatile==='s'&&f.proconfig[0]==='search_path=""'));
    for(const role of ["anon","service_role","collabflow_inquiry_writer","collabflow_inquiry_executor"]){
      for(const fn of ["public.list_creator_inquiries(timestamptz,uuid,integer)","public.get_creator_inquiry(uuid)"])
        assert.equal((await db.query("select has_function_privilege($1,$2,'execute') as allowed",[role,fn])).rows[0].allowed,false);
    }
    const tables=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where relnamespace='collabflow_private'::regnamespace and relkind='r'")).rows;
    assert.equal(tables.length,6);assert.ok(tables.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
    for(const table of ["inquiry_settings","inquiry_attempts","inquiry_rates","inquiry_receipts","inquiry_tokens"])
      await assert.rejects(as(a,`select * from collabflow_private.${table}`),e=>e.code==="42501");
    for(const sql of ["delete from collabflow_private.collaboration_inquiries", "update collabflow_private.collaboration_inquiries set sender_name='forged'", "select retention_due_at from collabflow_private.collaboration_inquiries", "select collabflow_private.cleanup_inquiry_data('inquiry_tokens',1)"])
      await assert.rejects(as(a,sql),e=>e.code==="42501");
    const publicColumns=(await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='creator_public_profiles'")).rows.map(r=>r.column_name);
    assert.ok(!publicColumns.includes('sender_email')&&!publicColumns.includes('message'));
  });
  await t.test("restricted intake, idempotency and maintenance remain usable after inbox grants",async()=>{
    await db.query("update creator_profiles set is_public=true where user_id=$1",[a]);
    const creator=(await db.query("select public_id from creator_profiles where user_id=$1",[a])).rows[0].public_id;
    // Keep this synthetic transaction open so writer work can be observed then
    // rolled back without changing other fixtures.
    await db.exec("begin");
    try {
      await db.exec("set local role collabflow_inquiry_writer");
      const beginSql="select collabflow_private.begin_inquiry_attempt(repeat('a',64),repeat('b',64),$1,$2,repeat('c',64)) as r";
      const submission="cccccccc-cccc-4ccc-8ccc-000000000001";
      const attempt=(await db.query(beginSql,[creator,submission])).rows[0].r;
      assert.equal(attempt.status,"ready");
      const accepted=(await db.query("select collabflow_private.finish_inquiry($1,'creator-a',repeat('d',64),'Brand','brand@example.test',null,'A fresh proposal for this creator') as r",[attempt.ticket])).rows[0].r;
      assert.equal(accepted.status,"accepted");
      assert.deepEqual((await db.query(beginSql,[creator,submission])).rows[0].r,accepted);
      await db.exec("reset role; set local role collabflow_maintenance");
      assert.equal((await db.query("select collabflow_private.cleanup_inquiry_data('inquiry_tokens',21) as n")).rows[0].n,0);
    } finally { await db.exec("rollback"); }
  });
});
