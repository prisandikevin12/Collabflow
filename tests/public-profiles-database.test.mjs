import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const legacy = "33333333-3333-4333-8333-333333333333";

test("M1 + M2A.1 migrations enforce publication, projection synchronization, and RLS in PostgreSQL", async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  // Minimal Supabase Auth contract, not a mock of PostgreSQL/RLS. Real hosted
  // Auth/PostgREST and administrator privileges still require staging checks.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  `);
  await db.exec("grant usage on schema public, auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;");
  await db.exec(file("supabase/migrations/20261119000100_creator_profiles.sql"));
  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [a, b, legacy]);
  // Run the original M1 assertions unchanged, adapting only psql's variables
  // and meta-commands for the embedded PostgreSQL driver.
  const m1Checks = file("supabase/tests/creator_profiles_rls.sql")
    .replace(/^\\.*$/gm, "")
    .replaceAll(":'user_a'", `'${a}'`).replaceAll(":'user_b'", `'${b}'`);
  await t.test("original M1 RLS checks pass before M2A.1", () => db.exec(m1Checks));
  await db.query("insert into public.creator_profiles (user_id, display_name, slug) values ($1, 'Legacy creator', 'legacy-private')", [legacy]);
  const before = await db.query("select policyname, roles, cmd, qual, with_check from pg_policies where tablename = 'creator_profiles' order by policyname");
  await db.exec(file("supabase/migrations/20261119000200_public_creator_profiles.sql"));
  const after = await db.query("select policyname, roles, cmd, qual, with_check from pg_policies where tablename = 'creator_profiles' order by policyname");
  assert.deepEqual(after.rows, before.rows, "M1 owner policies must remain identical");
  assert.equal((await db.query("select is_public from creator_profiles where user_id = $1", [legacy])).rows[0].is_public, false);
  assert.equal((await db.query("select * from creator_public_profiles")).rows.length, 0);
  await t.test("original M1 RLS checks still pass after M2A.1", () => db.exec(m1Checks));
  await db.query("select set_config('test.user_a', $1, false), set_config('test.user_b', $2, false)", [a, b]);
  await db.exec(file("supabase/tests/public_creator_profiles_rls.sql"));
  const role = (await db.query("select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'collabflow_profile_projector'")).rows[0];
  assert.deepEqual(role, { rolcanlogin: false, rolbypassrls: false, rolsuper: false });
  assert.equal((await db.query("select has_table_privilege('collabflow_profile_projector', 'creator_profiles', 'select') as allowed")).rows[0].allowed, false);
  const columns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='creator_public_profiles' order by ordinal_position")).rows.map(r => r.column_name);
  assert.deepEqual(columns, ["public_id", "slug", "display_name", "bio"]);
  await t.test("projection function and role retain least privilege", async () => {
    const fn = (await db.query(`select p.prosecdef, p.proconfig, r.rolname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
      where n.nspname = 'collabflow_private' and p.proname = 'sync_creator_public_profile'`)).rows[0];
    assert.equal(fn.prosecdef, true);
    assert.deepEqual(fn.proconfig, ['search_path=""']);
    assert.equal(fn.rolname, "collabflow_profile_projector");
    assert.equal((await db.query(`select count(*)::int as count from pg_auth_members m
      join pg_roles r on r.oid = m.roleid where r.rolname = 'collabflow_profile_projector'`)).rows[0].count, 0);
    for (const roleName of ["anon", "authenticated", "service_role"]) {
      const permissions = (await db.query(`select
        has_function_privilege($1, 'collabflow_private.sync_creator_public_profile()', 'execute') as execute,
        has_schema_privilege($1, 'collabflow_private', 'usage') as usage,
        has_table_privilege($1, 'creator_public_profiles', 'insert,update,delete') as write`, [roleName])).rows[0];
      assert.deepEqual(permissions, { execute: false, usage: false, write: false }, roleName);
    }
    const projector = (await db.query(`select
      has_schema_privilege('collabflow_profile_projector', 'collabflow_private', 'create') as create,
      has_table_privilege('collabflow_profile_projector', 'auth.users', 'select') as auth_read,
      has_table_privilege('collabflow_profile_projector', 'creator_profiles', 'insert,update,delete') as private_write`)).rows[0];
    assert.deepEqual(projector, { create: false, auth_read: false, private_write: false });
    const rls = (await db.query(`select relname, relrowsecurity, relforcerowsecurity from pg_class
      where oid in ('creator_profiles'::regclass, 'creator_public_profiles'::regclass)`)).rows;
    assert.equal(rls.length, 2);
    assert.ok(rls.every(row => row.relrowsecurity && row.relforcerowsecurity));
  });
  await t.test("clients cannot insert publication or identity fields, or read future private projection columns", async () => {
    // Every change is isolated to this in-memory test transaction.
    await db.exec(`begin;
      alter table creator_public_profiles add column future_private text;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${a}","role":"authenticated"}', true);
      do $$ begin
        begin
          insert into creator_profiles (user_id, display_name, slug, is_public)
          values (auth.uid(), 'Forged', 'forged-flag', true);
          raise exception 'Client can publish on insert';
        exception when insufficient_privilege then null; end;
        begin
          insert into creator_profiles (user_id, display_name, slug, public_id)
          values (auth.uid(), 'Forged', 'forged-id', gen_random_uuid());
          raise exception 'Client can choose public identity';
        exception when insufficient_privilege then null; end;
        begin
          perform future_private from creator_public_profiles;
          raise exception 'Authenticated future private column exposed';
        exception when insufficient_privilege then null; end;
      end $$;
      reset role;
      set local role anon;
      do $$ begin
        begin
          perform future_private from creator_public_profiles;
          raise exception 'Anonymous future private column exposed';
        exception when insufficient_privilege then null; end;
        perform public_id, slug, display_name, bio from creator_public_profiles;
      end $$;
      reset role;
      rollback;`);
  });
});
