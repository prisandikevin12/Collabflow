import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { handleInquiry } from "../lib/inquiries/intake.ts";
import { acceptedReceipt, submissionSnapshot } from "../lib/inquiries/client.ts";

const file = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const hash = text => createHash("sha256").update(text).digest("hex");
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";

for (const retention of [false, true]) {
test(`M2A.2 intake permissions, quotas and idempotency (retention ${retention ? "180 days" : "original"})`, async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.exec(file("supabase/migrations/20261119000100_creator_profiles.sql"));
  await db.exec(file("supabase/migrations/20261119000200_public_creator_profiles.sql"));
  const policies = await db.query("select * from pg_policies where schemaname='public' order by tablename, policyname");
  await db.exec(file("supabase/migrations/20261119000300_collaboration_inquiries.sql"));
  if (retention) await db.exec(file("supabase/migrations/20261120000100_inquiry_retention.sql"));
  assert.deepEqual((await db.query("select * from pg_policies where schemaname='public' order by tablename, policyname")).rows, policies.rows);
  await db.query("insert into auth.users (id) values ($1), ($2)", [a, b]);

  await t.test("original M1 and M2A.1 SQL authorization checks still pass", async () => {
    await db.exec(file("supabase/tests/creator_profiles_rls.sql").replace(/^\\.*$/gm, "")
      .replaceAll(":'user_a'", `'${a}'`).replaceAll(":'user_b'", `'${b}'`));
    await db.query("select set_config('test.user_a', $1, false), set_config('test.user_b', $2, false)", [a, b]);
    await db.exec(file("supabase/tests/public_creator_profiles_rls.sql"));
  });
  await db.query("insert into creator_profiles (user_id, display_name, slug, is_public) values ($1, 'Public creator', 'public-creator', true), ($2, 'Private creator', 'private-creator', false)", [a, b]);
  const profiles = (await db.query("select user_id, public_id from creator_profiles")).rows;
  const creator = profiles.find(p => p.user_id === a).public_id;
  const privateCreator = profiles.find(p => p.user_id === b).public_id;

  async function isolated(name, run) {
    await t.test(name, async () => {
      await db.exec("begin");
      try { await run(); } finally { await db.exec("rollback"); }
    });
  }
  async function asRole(role, query, params = []) {
    assert.ok(["collabflow_inquiry_writer", "anon", "authenticated"].includes(role));
    await db.exec(`savepoint role_call; set local role ${role}`);
    try {
      const result = await db.query(query, params);
      await db.exec("reset role; release savepoint role_call");
      return result;
    } catch (error) {
      await db.exec("rollback to savepoint role_call; release savepoint role_call");
      throw error;
    }
  }
  async function begin({ ip = hash("ip"), email = hash("email"), creatorId = creator,
    submission = randomUUID(), fingerprint = hash("proposal") } = {}) {
    return (await asRole("collabflow_inquiry_writer",
      "select collabflow_private.begin_inquiry_attempt($1, $2, $3::uuid, $4::uuid, $5) as result",
      [ip, email, creatorId, submission, fingerprint])).rows[0].result;
  }
  async function finish(ticket, { slug = "public-creator", token = hash(randomUUID()),
    name = "Alice", email = "alice@example.test", company = "", message = "A collaboration proposal." } = {}) {
    return (await asRole("collabflow_inquiry_writer",
      "select collabflow_private.finish_inquiry($1::uuid, $2, $3, $4, $5, $6, $7) as result",
      [ticket, slug, token, name, email, company, message])).rows[0].result;
  }
  const count = async () => (await db.query("select count(*)::int as n from collabflow_private.collaboration_inquiries")).rows[0].n;

  await isolated("all six tables force RLS; writer has only the two intake functions", async () => {
    const tables = (await db.query("select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='collabflow_private' and c.relkind='r'")).rows;
    assert.equal(tables.length, 6);
    assert.ok(tables.every(table => table.relrowsecurity && table.relforcerowsecurity));
    for (const role of ["anon", "authenticated", "service_role", "collabflow_inquiry_writer"]) {
      for (const table of tables) {
        const p = (await db.query("select has_table_privilege($1, $2, 'select,insert,update,delete,truncate') as allowed", [role, `collabflow_private.${table.relname}`])).rows[0];
        assert.equal(p.allowed, false, `${role} ${table.relname}`);
      }
    }
    const functions = (await db.query(`select p.oid::regprocedure::text as signature, p.proname, p.prosecdef, p.proconfig, r.rolname
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
      where n.nspname='collabflow_private' and p.proname in ('lock_inquiry_publication', 'inquiry_take_rate', 'begin_inquiry_attempt', 'finish_inquiry')`)).rows;
    assert.equal(functions.length, 4);
    for (const fn of functions) {
      assert.deepEqual(fn.proconfig, ['search_path=""']);
      assert.equal(fn.prosecdef, fn.proname !== "inquiry_take_rate");
      for (const role of ["anon", "authenticated", "service_role", "collabflow_inquiry_writer"]) {
        const allowed = (await db.query("select has_function_privilege($1, $2, 'execute') as allowed", [role, fn.signature])).rows[0].allowed;
        assert.equal(allowed, role === "collabflow_inquiry_writer" && ["begin_inquiry_attempt", "finish_inquiry"].includes(fn.proname), `${role} ${fn.proname}`);
      }
    }
    for (const role of ["collabflow_inquiry_writer", "collabflow_inquiry_executor"]) {
      const flags = (await db.query("select rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname=$1", [role])).rows[0];
      assert.deepEqual(flags, { rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: role.endsWith("writer") });
      assert.equal((await db.query("select has_schema_privilege($1, 'collabflow_private', 'create') as allowed", [role])).rows[0].allowed, false);
      assert.equal((await db.query("select count(*)::int as n from pg_auth_members where roleid=(select oid from pg_roles where rolname=$1)", [role])).rows[0].n, 0);
    }
    for (const role of ["anon", "authenticated", "collabflow_inquiry_writer"]) {
      await assert.rejects(asRole(role, "select * from collabflow_private.collaboration_inquiries"), e => e.code === "42501");
      await assert.rejects(asRole(role, "insert into collabflow_private.collaboration_inquiries (creator_public_id, sender_name, sender_email, message) values ($1, 'Alice', 'a@example.test', 'A valid proposal.')", [creator]), e => e.code === "42501");
    }
  });

  await isolated("accepted submission stores normalized content but no IP, email hash, or challenge token in inquiries", async () => {
    const attempt = await begin();
    assert.equal(attempt.status, "ready");
    const result = await finish(attempt.ticket, { name: "Alice 😀", message: "Line one\nLine two" });
    assert.equal(result.status, "accepted");
    const rows = (await db.query("select * from collabflow_private.collaboration_inquiries")).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].creator_public_id, creator);
    assert.equal(rows[0].sender_name, "Alice 😀"); assert.equal(rows[0].company, null);
    if (retention) {
      const duration = new Date(rows[0].retention_due_at) - new Date(rows[0].created_at);
      assert.ok(Math.abs(duration - 180 * 86400000) < 1000);
    } else assert.equal(rows[0].retention_due_at, null);
    assert.deepEqual(Object.keys(rows[0]), ["id", "creator_public_id", "sender_name", "sender_email", "company", "message", "created_at", "retention_due_at"]);
  });

  await isolated("interleaved identical submissions and lost-response retries produce exactly one inquiry", async () => {
    const submission = randomUUID();
    const first = await begin({ submission }); const second = await begin({ submission });
    assert.equal(first.status, "ready"); assert.equal(second.status, "ready");
    const result = await finish(first.ticket);
    if (retention) {
      for (const table of ["collaboration_inquiries", "inquiry_attempts", "inquiry_rates", "inquiry_receipts", "inquiry_tokens"]) {
        assert.equal((await db.query("select collabflow_private.cleanup_inquiry_data($1, 1000) as n", [table])).rows[0].n, 0);
      }
    }
    assert.deepEqual(await finish(second.ticket), result);
    assert.deepEqual(await begin({ submission }), result);
    assert.equal((await begin({ submission, fingerprint: hash("changed") })).status, "conflict");
    assert.equal(await count(), 1);
  });

  await isolated("two conflicting pending payloads cannot both win the same submission id", async () => {
    const submission = randomUUID();
    const first = await begin({ submission }); const second = await begin({ submission, fingerprint: hash("different") });
    assert.equal((await finish(first.ticket)).status, "accepted");
    assert.equal((await finish(second.ticket)).status, "conflict");
    assert.equal(await count(), 1);
  });

  await isolated("local token ledger blocks provider token replay across distinct submissions", async () => {
    const token = hash("same-token");
    assert.equal((await finish((await begin()).ticket, { token })).status, "accepted");
    assert.equal((await finish((await begin()).ticket, { token })).status, "replay");
    assert.equal(await count(), 1);
  });

  await isolated("invalid, expired and already-used tickets cannot create another inquiry", async () => {
    assert.equal((await finish(randomUUID())).status, "expired");
    const expired = await begin();
    await db.query("update collabflow_private.inquiry_attempts set expires_at=clock_timestamp()-interval '1 second' where ticket=$1", [expired.ticket]);
    assert.equal((await finish(expired.ticket)).status, "expired");
    const used = await begin(); await finish(used.ticket);
    assert.equal((await finish(used.ticket)).status, "expired");
    assert.equal(await count(), 1);
  });

  await isolated("unknown, private, renamed and newly unpublished creators reject submissions", async () => {
    for (const creatorId of [randomUUID(), privateCreator]) {
      assert.equal((await finish((await begin({ creatorId })).ticket)).status, "not-found");
    }
    const renamed = await begin();
    await db.query("update creator_profiles set slug='renamed-creator' where user_id=$1", [a]);
    assert.equal((await finish(renamed.ticket)).status, "not-found");
    const unpublished = await begin();
    await db.query("update creator_profiles set is_public=false where user_id=$1", [a]);
    assert.equal((await finish(unpublished.ticket, { slug: "renamed-creator" })).status, "not-found");
    assert.equal(await count(), 0);
  });

  await isolated("database constraints reject direct malformed finalization atomically", async () => {
    for (const fields of [{ name: "" }, { email: "invalid" }, { company: "x".repeat(121) }, { message: "short" }]) {
      const attempt = await begin();
      await assert.rejects(finish(attempt.ticket, fields), e => e.code === "23514");
    }
    assert.equal(await count(), 0);
    assert.equal((await db.query("select count(*)::int as n from collabflow_private.inquiry_tokens")).rows[0].n, 0);
    assert.equal((await begin({ ip: "unhashed" })).status, "invalid");
  });

  await isolated("attempt quotas persist across distinct requests before any external verification", async () => {
    for (let i = 0; i < 20; i++) assert.equal((await begin()).status, "ready");
    assert.equal((await begin()).status, "throttled");
    assert.equal((await db.query("select count(*)::int as n from collabflow_private.inquiry_attempts")).rows[0].n, 20);
  });

  await isolated("global preflight cap bounds key allocations", async () => {
    await begin();
    await db.exec("update collabflow_private.inquiry_rates set hits=10000 where scope='attempt-global'");
    assert.equal((await begin({ ip: hash("new attacker ip") })).status, "throttled");
    assert.equal((await db.query("select count(*)::int as n from collabflow_private.inquiry_rates where subject=$1", [hash("new attacker ip")])).rows[0].n, 0);
  });

  await isolated("accepted email-per-creator and IP quotas limit stored inquiries", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await finish((await begin()).ticket)).status, "accepted");
    assert.equal((await finish((await begin()).ticket)).status, "throttled");
    // Denied attempts count conservatively toward accepted quotas.
    assert.equal((await finish((await begin({ email: hash("other email") })).ticket)).status, "accepted");
    assert.equal((await finish((await begin({ email: hash("third email") })).ticket)).status, "throttled");
    assert.equal(await count(), 4);
  });

  await isolated("daily creator and global caps deny further writes", async () => {
    await finish((await begin()).ticket);
    await db.exec("update collabflow_private.inquiry_rates set hits=100 where scope='accepted-creator'");
    assert.equal((await finish((await begin()).ticket)).status, "throttled");
    await db.exec("update collabflow_private.inquiry_rates set hits=0 where scope='accepted-creator'; update collabflow_private.inquiry_rates set hits=1000 where scope='accepted-global'");
    assert.equal((await finish((await begin()).ticket)).status, "throttled");
    assert.equal(await count(), 1);
  });

  await isolated("unpublishing retains received inquiries; account deletion cascades", async () => {
    await finish((await begin()).ticket);
    await db.query("update creator_profiles set is_public=false where user_id=$1", [a]);
    assert.equal(await count(), 1);
    await db.query("delete from auth.users where id=$1", [a]);
    assert.equal(await count(), 0);
  });

  await isolated("HTTP intake orchestration persists via restricted functions and retries idempotently", async () => {
    const cfg = { enabled: true, origins: ["https://collabflow.example"], hostnames: ["collabflow.example"], vercel: true, turnstileSecret: "fixture", hmacSecret: "test-secret-".repeat(4) };
    const data = { creatorPublicId: creator, creatorSlug: "public-creator", submissionId: randomUUID(), senderName: "Alice", senderEmail: "alice@example.test", message: "A collaboration proposal.", company: "", website: "", turnstileToken: "fake-challenge" };
    const request = () => new Request(cfg.origins[0] + "/api/inquiries", { method: "POST", headers: { origin: cfg.origins[0], "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.1" }, body: JSON.stringify(data) });
    const store = () => ({
      begin: x => begin({ ip: x.ipHash, email: x.emailHash, creatorId: x.creatorId, submission: x.submissionId, fingerprint: x.fingerprint }),
      finish: (ticket, value, token) => finish(ticket, { slug: value.creatorSlug, token, name: value.senderName, email: value.senderEmail, company: value.company, message: value.message }),
    });
    let verifications = 0;
    const verify = async () => { verifications++; return true; };
    const first = await handleInquiry(request(), cfg, store, verify);
    assert.equal(first.status, 200);
    const retry = await handleInquiry(request(), cfg, store, verify);
    assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), await first.json());
    assert.equal(await count(), 1); assert.equal(verifications, 1);
  });

  await t.test("lost response after commit: unchanged form retry reuses submission ID and original receipt with one inquiry", async () => {
    // Keep this last: unlike the rollback-isolated cases, these dummy writes
    // really commit in this disposable database before the response is lost.
    const cfg = { enabled: true, origins: ["https://collabflow.example"], hostnames: ["collabflow.example"], vercel: true, turnstileSecret: "fixture", hmacSecret: "test-secret-".repeat(4) };
    const fields = { senderName: "Retry Sender", senderEmail: "retry@example.test", company: "Dummy Brand", message: "A dummy proposal whose first response is lost.", website: "" };
    const originalId = "66666666-6666-4666-8666-666666666666";
    let generatedIds = 0;
    const makeId = () => ++generatedIds === 1 ? originalId : "77777777-7777-4777-8777-777777777777";
    const originalSnapshot = submissionSnapshot(null, creator, "public-creator", fields, makeId);
    async function committed(run) {
      await db.exec("begin");
      try {
        const result = await run();
        await db.exec("commit");
        return result;
      } catch (error) { await db.exec("rollback"); throw error; }
    }
    const store = () => ({
      begin: x => committed(() => begin({ ip: x.ipHash, email: x.emailHash, creatorId: x.creatorId, submission: x.submissionId, fingerprint: x.fingerprint })),
      finish: (ticket, value, token) => committed(() => finish(ticket, { slug: value.creatorSlug, token, name: value.senderName, email: value.senderEmail, company: value.company, message: value.message })),
    });
    let verifications = 0;
    const verify = async () => { verifications++; return true; }; // No external Turnstile calls.
    const request = (snapshot, token) => new Request(cfg.origins[0] + "/api/inquiries", {
      method: "POST", headers: { origin: cfg.origins[0], "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.1" },
      body: JSON.stringify({ ...fields, creatorPublicId: creator, creatorSlug: "public-creator", submissionId: snapshot.id, turnstileToken: token }),
    });
    let originalReceipt;
    // Simulate transport failure only AFTER handleInquiry has committed the
    // inquiry and generated its response. No response reaches the caller.
    async function lostResponse() {
      const response = await handleInquiry(request(originalSnapshot, "first-dummy-challenge"), cfg, store, verify);
      assert.equal(response.status, 200);
      originalReceipt = (await response.json()).receipt;
      throw new TypeError("Simulated connection loss after database commit");
    }
    assert.equal(await count(), 0);
    await assert.rejects(lostResponse(), { name: "TypeError", message: "Simulated connection loss after database commit" });
    const saved = (await db.query("select id, sender_email, message from collabflow_private.collaboration_inquiries")).rows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].sender_email, fields.senderEmail);
    assert.equal(saved[0].message, fields.message);
    const receipts = () => db.query("select submission_id, receipt from collabflow_private.inquiry_receipts");
    assert.deepEqual((await receipts()).rows, [{ submission_id: originalId, receipt: originalReceipt }]);

    // Same mounted form, unchanged fields, newly prepared verification token.
    const retrySnapshot = submissionSnapshot(originalSnapshot, creator, "public-creator", { ...fields }, makeId);
    assert.equal(retrySnapshot.id, originalId);
    assert.equal(generatedIds, 1);
    const retry = await handleInquiry(request(retrySnapshot, "fresh-dummy-challenge"), cfg, store, verify);
    assert.equal(retry.status, 200);
    assert.equal(acceptedReceipt(retry.status, await retry.json()), originalReceipt);
    assert.equal(await count(), 1);
    assert.deepEqual((await db.query("select id, sender_email, message from collabflow_private.collaboration_inquiries")).rows, saved);
    assert.deepEqual((await receipts()).rows, [{ submission_id: originalId, receipt: originalReceipt }]);
    assert.equal(verifications, 1, "An existing receipt is returned before verifying another challenge");
  });
});

}
