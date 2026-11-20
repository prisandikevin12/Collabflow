import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";

// No dotenv and no hosted target. Supply a disposable LOCAL PostgreSQL admin
// connection explicitly. A uniquely named database and roles are created and
// removed by this test; no existing database or role is modified/dropped.
const connection = process.env.COLLABFLOW_CLEANUP_TEST_DATABASE_URL;
test("independent PostgreSQL sessions skip locked rows, divide batches and recover rolled-back work", {
  skip: !connection && "No disposable loopback PostgreSQL configured; PGlite cannot test simultaneous sessions",
  timeout: 60000,
}, async () => {
  const url = new URL(connection);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname), "Only numeric loopback addresses are allowed");
  assert.equal(url.search, "", "Connection query overrides are forbidden");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const database = `cf_cleanup_test_${suffix}`;
  const names = ["anon", "authenticated", "service_role", "collabflow_profile_projector",
    "collabflow_inquiry_writer", "collabflow_inquiry_executor", "collabflow_cleanup_executor", "collabflow_maintenance"];
  const roles = Object.fromEntries(names.map((name, i) => [name, `cf_cleanup_${suffix}_${i}`]));
  const rename = sql => sql.replace(new RegExp(`\\b(${names.join("|")})\\b`, "g"), name => roles[name]);
  const admin = postgres(connection, { max: 1, connect_timeout: 5, onnotice() {} });
  let db;
  let created = false;
  const sessions = [];
  try {
    assert.equal((await admin`select rolsuper from pg_roles where rolname=current_user`)[0].rolsuper, true,
      "Use a disposable local superuser, never a production connection");
    await admin.unsafe(`create database ${database}`);
    created = true;
    url.pathname = `/${database}`;
    db = postgres(url.toString(), { max: 4, connect_timeout: 5, onnotice() {},
      connection: { statement_timeout: 5000, lock_timeout: 2000 } });
    await db.unsafe(rename(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      grant usage on schema public, auth to anon, authenticated;`));
    for (const name of ["20261119000100_creator_profiles", "20261119000200_public_creator_profiles",
      "20261119000300_collaboration_inquiries", "20261120000100_inquiry_retention"]) {
      await db.unsafe(rename(readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8")));
    }
    await db`insert into collabflow_private.inquiry_tokens (token_hash, expires_at)
      select 'expired-' || n, now()-interval '1 day' from generate_series(1,7) n`;
    await db`insert into collabflow_private.inquiry_tokens values ('future', now()+interval '1 day')`;
    const blocker = await db.reserve(); sessions.push(blocker);
    const first = await db.reserve(); sessions.push(first);
    const second = await db.reserve(); sessions.push(second);
    await blocker`begin`;
    await blocker`select token_hash from collabflow_private.inquiry_tokens where token_hash='expired-1' for update`;
    for (const session of [first, second]) {
      await session.unsafe(`begin; set local role ${roles.collabflow_maintenance}`);
    }
    // Neither worker commits until BOTH calls finish. Without SKIP LOCKED,
    // they block on the keeper or one another and hit the two-second timeout.
    const results = await Promise.all([first, second].map(session => session`
      select collabflow_private.cleanup_inquiry_data('inquiry_tokens',2) as n`));
    assert.deepEqual(results.map(r => r[0].n), [2, 2]);
    await first`commit`;
    await second`rollback`; // aborted deletion must remain eligible on retry
    await blocker`rollback`;
    await first.unsafe(`begin; set local role ${roles.collabflow_maintenance}`);
    assert.equal((await first`select collabflow_private.cleanup_inquiry_data('inquiry_tokens',2000) as n`)[0].n, 5);
    await first`commit`;
    assert.deepEqual((await db`select token_hash from collabflow_private.inquiry_tokens`).map(r => r.token_hash), ["future"]);
    await first.unsafe(`begin; set local role ${roles.collabflow_maintenance}`);
    assert.equal((await first`select collabflow_private.cleanup_inquiry_data('inquiry_tokens',2000) as n`)[0].n, 0);
    await first`commit`;
  } finally {
    for (const session of sessions) {
      try { await session`rollback`; } finally { session.release(); }
    }
    if (db) await db.end({ timeout: 5 });
    if (created) {
      // Identifiers are generated above, never supplied by the connection URL.
      await admin.unsafe(`drop database ${database}`);
      for (const role of Object.values(roles).reverse()) await admin.unsafe(`drop role if exists ${role}`);
    }
    await admin.end({ timeout: 5 });
  }
});
