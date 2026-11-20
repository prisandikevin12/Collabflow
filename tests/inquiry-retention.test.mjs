import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const file = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const migration = file("supabase/migrations/20261120000100_inquiry_retention.sql");
const tables = ["collaboration_inquiries", "inquiry_attempts", "inquiry_rates", "inquiry_receipts", "inquiry_tokens"];
const appRoles = ["anon", "authenticated", "service_role", "collabflow_inquiry_writer", "collabflow_inquiry_executor"];

test("retention cleanup executes with restricted privileges in PostgreSQL", async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
  `);
  for (const name of ["20261119000100_creator_profiles", "20261119000200_public_creator_profiles", "20261119000300_collaboration_inquiries"]) {
    await db.exec(file(`supabase/migrations/${name}.sql`));
  }
  const user = randomUUID();
  await db.query("insert into auth.users values ($1)", [user]);
  const creator = (await db.query("insert into public.creator_profiles (user_id, display_name, slug, is_public) values ($1, 'Creator', 'test-creator', true) returning public_id", [user])).rows[0].public_id;
  // These are actual pre-migration records, including an already-expired one.
  await db.query(`insert into collabflow_private.collaboration_inquiries
    (creator_public_id, sender_name, sender_email, message, created_at, retention_due_at)
    values ($1, 'Legacy', 'test@example.test', 'A legacy proposal', now()-interval '200 days', null),
      ($1, 'Legacy', 'test@example.test', 'A legacy proposal', now()-interval '200 days', now()-interval '20 days')`, [creator]);
  const legacy = (await db.query("select * from collabflow_private.collaboration_inquiries order by id")).rows;
  await db.exec(file("supabase/operations/inquiry-retention-preflight.sql"));
  await db.exec(migration);
  await db.exec(file("supabase/operations/inquiry-retention-preflight.sql"));
  assert.deepEqual((await db.query("select * from collabflow_private.collaboration_inquiries order by id")).rows, legacy);
  assert.equal((await db.query("select retention_days from collabflow_private.inquiry_settings")).rows[0].retention_days, 180);
  await t.test("reapplying the migration fails atomically without moving the legacy boundary", async () => {
    const settings = (await db.query("select * from collabflow_private.inquiry_settings")).rows;
    await assert.rejects(db.exec(migration), e => e.code === "42701");
    await db.exec("rollback");
    assert.deepEqual((await db.query("select * from collabflow_private.inquiry_settings")).rows, settings);
    assert.deepEqual((await db.query("select * from collabflow_private.collaboration_inquiries order by id")).rows, legacy);
  });

  async function roleQuery(role, sql, params = []) {
    assert.ok([...appRoles, "collabflow_maintenance", "collabflow_cleanup_executor"].includes(role));
    await db.exec(`savepoint role_call; set local role ${role}`);
    try {
      const result = await db.query(sql, params);
      await db.exec("reset role; release savepoint role_call");
      return result;
    } catch (error) {
      await db.exec("rollback to savepoint role_call; release savepoint role_call");
      throw error;
    }
  }
  const clean = async (table, size = 1000) => (await roleQuery("collabflow_maintenance", "select collabflow_private.cleanup_inquiry_data($1, $2) as n", [table, size])).rows[0].n;
  async function isolated(name, run) {
    await t.test(name, async () => {
      await db.exec("begin");
      try { await run(); } finally { await db.exec("rollback"); }
    });
  }
  async function metadata(table) {
    const future = "statement_timestamp()+interval '1 day'";
    const past = "statement_timestamp()-interval '1 second'";
    // Three expired, two future rows in each table.
    for (let i = 0; i < 5; i++) {
      const expiry = i < 3 ? past : future;
      if (table === "inquiry_rates") await db.exec(`insert into collabflow_private.inquiry_rates values ('fixture', '${i}', 0, 1, ${expiry})`);
      if (table === "inquiry_tokens") await db.exec(`insert into collabflow_private.inquiry_tokens values ('${i}', ${expiry})`);
      if (table === "inquiry_receipts") await db.query(`insert into collabflow_private.inquiry_receipts values ($1, $2, 'fixture', $3, ${expiry})`, [creator, randomUUID(), randomUUID()]);
      if (table === "inquiry_attempts") await db.query(`insert into collabflow_private.inquiry_attempts (ip_hash, email_hash, creator_id, submission_id, fingerprint, expires_at) values ('fixture', 'fixture', $1, $2, 'fixture', ${expiry})`, [creator, randomUUID()]);
    }
  }

  await isolated("legacy inquiries remain unchanged and ineligible, including expired deadlines", async () => {
    assert.equal(await clean("collaboration_inquiries"), 0);
    assert.deepEqual((await db.query("select * from collabflow_private.collaboration_inquiries order by id")).rows, legacy);
  });
  for (const table of tables.slice(1)) {
    await isolated(`${table}: future records survive, batches are bounded, retries are idempotent`, async () => {
      await metadata(table);
      assert.equal(await clean(table, 2), 2);
      assert.equal(await clean(table, 2), 1);
      assert.equal(await clean(table, 2), 0);
      assert.equal((await db.query(`select count(*)::int as n from collabflow_private.${table}`)).rows[0].n, 2);
    });
  }
  await isolated("180-day boundary: before survives, exact deadline and after expire; NULL survives", async () => {
    // Move only the synthetic policy boundary back in this rolled-back fixture.
    await db.exec("update collabflow_private.inquiry_settings set retention_effective_at=now()-interval '190 days'");
    // One statement fixes statement_timestamp for exact-boundary assertions.
    await db.query(`insert into collabflow_private.collaboration_inquiries
      (creator_public_id, sender_name, sender_email, message, created_at, retention_due_at)
      select $1, 'Boundary', 'test@example.test', 'Boundary proposal',
        statement_timestamp()-interval '180 days'+delta,
        case when delta=interval '2 days' then null else statement_timestamp()+delta end
      from unnest(array[interval '-1 second', interval '0', interval '1 day', interval '2 days']) delta`, [creator]);
    assert.equal(await clean("collaboration_inquiries", 1), 1);
    assert.equal(await clean("collaboration_inquiries", 1), 1);
    assert.equal(await clean("collaboration_inquiries"), 0);
    const rows = (await db.query("select sender_name, retention_due_at from collabflow_private.collaboration_inquiries")).rows;
    assert.equal(rows.length, 4); // two legacy, two new preserved
    // Precisely equality, without relying on elapsed wall time between queries.
    await db.exec(`do $$ declare n integer; begin
      insert into collabflow_private.collaboration_inquiries
        (creator_public_id, sender_name, sender_email, message, created_at, retention_due_at)
        select public_id, 'Exact', 'test@example.test', 'Exact boundary proposal', statement_timestamp()-interval '180 days', statement_timestamp()
        from public.creator_profiles;
      set local role collabflow_maintenance;
      n := collabflow_private.cleanup_inquiry_data('collaboration_inquiries', 1000);
      if n <> 1 then raise exception 'Exact boundary not removed: %', n; end if;
    end $$; reset role;`);
  });
  await isolated("invalid batches and identifiers are rejected without deleting anything", async () => {
    await metadata("inquiry_tokens");
    for (const size of [null, 0, -1, 2001]) await assert.rejects(clean("inquiry_tokens", size), e => e.code === "22023");
    for (const table of [null, "inquiry_settings", "inquiry_tokens; drop schema public cascade"])
      await assert.rejects(clean(table), e => e.code === "22023");
    assert.equal(await clean("inquiry_tokens", 2000), 3);
  });
  await isolated("a mistakenly early deadline cannot shorten the 180-day retention floor", async () => {
    await db.query(`insert into collabflow_private.collaboration_inquiries
      (creator_public_id,sender_name,sender_email,message,retention_due_at)
      values ($1,'New','new@example.test','A new proposal',now()-interval '1 day')`, [creator]);
    assert.equal(await clean("collaboration_inquiries"), 0);
    assert.equal((await roleQuery("collabflow_cleanup_executor", "delete from collabflow_private.collaboration_inquiries")).affectedRows, 0);
  });
  await isolated("maximum permitted batch removes exactly 2000 and leaves the remainder for a later call", async () => {
    await db.exec("insert into collabflow_private.inquiry_tokens select n::text, now()-interval '1 second' from generate_series(1,2001) n");
    assert.equal(await clean("inquiry_tokens", 2000), 2000);
    assert.equal(await clean("inquiry_tokens", 2000), 1);
    assert.equal(await clean("inquiry_tokens", 2000), 0);
  });
  await isolated("application roles cannot call cleanup, DELETE, TRUNCATE, or assume maintenance roles", async () => {
    for (const role of appRoles) {
      await assert.rejects(roleQuery(role, "select collabflow_private.cleanup_inquiry_data('inquiry_tokens', 1)"), e => e.code === "42501");
      for (const table of tables) {
        const p = (await db.query("select has_table_privilege($1, $2, 'delete,truncate') as allowed", [role, `collabflow_private.${table}`])).rows[0];
        assert.equal(p.allowed, false, `${role} ${table}`);
        await assert.rejects(roleQuery(role, `delete from collabflow_private.${table}`), e => e.code === "42501");
      }
      for (const admin of ["collabflow_maintenance", "collabflow_cleanup_executor"]) {
        assert.equal((await db.query("select pg_has_role($1, $2, 'member') as member", [role, admin])).rows[0].member, false);
      }
    }
    await assert.rejects(roleQuery("collabflow_maintenance", "delete from collabflow_private.inquiry_tokens"), e => e.code === "42501");
    await assert.rejects(roleQuery("collabflow_cleanup_executor", "select sender_email, message from collabflow_private.collaboration_inquiries"), e => e.code === "42501");
  });
  await isolated("FORCE RLS constrains even direct cleanup-executor deletes and blocks updates", async () => {
    await metadata("inquiry_tokens");
    const result = await roleQuery("collabflow_cleanup_executor", "delete from collabflow_private.inquiry_tokens");
    assert.equal(result.affectedRows, 3);
    assert.equal((await db.query("select count(*)::int as n from collabflow_private.inquiry_tokens")).rows[0].n, 2);
    await metadata("inquiry_attempts");
    await assert.rejects(roleQuery("collabflow_cleanup_executor", "update collabflow_private.inquiry_attempts set expires_at=now()-interval '1 year'"), e => e.code === "42501");
    assert.equal((await roleQuery("collabflow_cleanup_executor", "delete from collabflow_private.collaboration_inquiries")).affectedRows, 0);
  });
  await isolated("definer ownership, empty search_path, ACLs, indexes and FORCE RLS remain constrained", async () => {
    const fn = (await db.query(`select p.prosecdef, p.proconfig, r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
      where p.oid='collabflow_private.cleanup_inquiry_data(text,integer)'::regprocedure`)).rows[0];
    assert.deepEqual(fn, { prosecdef: true, proconfig: ['search_path=""'], rolname: "collabflow_cleanup_executor" });
    for (const role of ["collabflow_cleanup_executor", "collabflow_maintenance"]) {
      const flags = (await db.query("select rolsuper, rolcanlogin, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication from pg_roles where rolname=$1", [role])).rows[0];
      assert.ok(Object.values(flags).every(value => value === false));
      assert.equal((await db.query("select has_schema_privilege($1, 'collabflow_private', 'create') as allowed", [role])).rows[0].allowed, false);
      assert.equal((await db.query("select count(*)::int as n from pg_class where relowner=(select oid from pg_roles where rolname=$1) and relkind='r'", [role])).rows[0].n, 0);
    }
    const relations = (await db.query("select relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='collabflow_private' and relkind='r'")).rows;
    assert.equal(relations.length, 6);
    assert.ok(relations.every(r => r.relrowsecurity && r.relforcerowsecurity));
    assert.equal((await db.query("select count(*)::int as n from pg_indexes where schemaname='collabflow_private' and (indexname like '%_expiry' or indexname='collaboration_inquiries_retention_due')")).rows[0].n, 5);
    assert.match(migration, /limit \$1 for update skip locked/i);
    assert.doesNotMatch(migration, /create extension|cron\.schedule/i);
  });

  await t.test("Cron activation fails closed; scheduler SQL and bounded history run against a fixture", async () => {
    const activation = file("supabase/operations/inquiry-cleanup-activate.sql");
    assert.doesNotMatch(activation.replace(/^\s*--.*$/gm, ""), /create\s+(?:unique\s+)?index|alter\s+table|grant\s+[^;]+\s+on\s+cron\./i);
    await assert.rejects(db.exec(activation), /explicit review and opt-in/);
    await db.exec("rollback; set collabflow.approve_cleanup='reviewed-180-day-policy-and-cleanup'");
    // A stale approved session setting cannot authorize a fresh default script.
    await assert.rejects(db.exec(activation), /explicit review and opt-in/);
    await db.exec("rollback; reset collabflow.approve_cleanup");
    const approvedActivation = activation.replace("approval constant text := 'NOT_APPROVED'",
      "approval constant text := 'reviewed-180-day-policy-and-cleanup'");
    assert.notEqual(approvedActivation, activation);
    await assert.rejects(db.exec(approvedActivation), /pg_cron must be installed separately/);
    await db.exec("rollback");
    // PGlite has no pg_cron worker. Mock registration only; execute the actual
    // scheduled SQL below. This does NOT claim to test the Cron runtime.
    await db.exec(`create role cron_fixture_owner nologin;
      create role cron_fixture_admin nologin nosuperuser nobypassrls;
      create schema cron;
      create table cron.job (jobid bigint generated always as identity primary key,
        jobname text, schedule text, command text, username text default current_user,
        database text default current_database(), active boolean default true, unique(jobname, username));
      create table cron.job_run_details (runid bigint generated always as identity primary key,
        jobid bigint, username text default current_user, status text, start_time timestamptz, end_time timestamptz);
      create function cron.schedule(text, text, text) returns bigint language sql as $$
        insert into cron.job (jobname,schedule,command) values ($1,$2,$3)
        on conflict(jobname,username) do update set schedule=excluded.schedule, command=excluded.command returning jobid $$;
      create function cron.alter_job(job_id bigint, active boolean) returns void language sql as $$
        update cron.job set active=$2 where jobid=$1 $$;
      alter table cron.job owner to cron_fixture_owner;
      alter table cron.job enable row level security;
      create policy job_owner on cron.job using (username=current_user);
      alter table cron.job_run_details owner to cron_fixture_owner;
      alter table cron.job_run_details enable row level security;
      create policy history_owner on cron.job_run_details using (username=current_user);
      grant usage on schema cron to cron_fixture_admin;
      grant select on cron.job to cron_fixture_admin;
      grant select, delete on cron.job_run_details to cron_fixture_admin;`);
    const monitor = file("supabase/operations/inquiry-cleanup-monitor.sql");
    const monitorRows = async () => {
      await db.exec("begin transaction read only");
      try {
        const result = await db.exec(monitor);
        assert.equal(result.length, 1, "one SQL Editor result grid");
        return result[0].rows;
      } finally { await db.exec("rollback"); }
    };
    const unscheduled = await monitorRows();
    assert.equal(unscheduled.length, 6);
    assert.ok(unscheduled.every(j => j.missing_job && j.job_state === "not_scheduled"));
    assert.ok(unscheduled.every(j => j.unexpected_schedule === false && j.stale_success === false && j.unexpected_database === false));
    const fixtureActivation = approvedActivation.replace("extname='pg_cron'", "extname='plpgsql'");
    await db.exec(fixtureActivation);
    const jobs = (await db.query("select * from cron.job order by jobid")).rows;
    assert.equal(jobs.length, 6);
    assert.ok((await monitorRows()).every(j => j.job_state === "not_run" && j.stale_success === true));
    await db.exec(fixtureActivation);
    assert.deepEqual((await db.query("select * from cron.job order by jobid")).rows, jobs);
    // Derive capacity from actual schedules and the existing intake caps.
    const matches = (value, field) => {
      const [range, step = "1"] = field.split("/");
      const [start, end] = range === "*" ? [0, Infinity] : range.split("-").map(Number);
      return value >= start && value <= (end ?? start) && (value - start) % Number(step) === 0;
    };
    const dailyRuns = schedule => {
      const [minute, hour, ...rest] = schedule.split(" ");
      assert.deepEqual(rest, ["*", "*", "*"]);
      let count = 0;
      for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) if (matches(m, minute) && matches(h, hour)) count++;
      return count;
    };
    const original = file("supabase/migrations/20261119000300_collaboration_inquiries.sql");
    const attempts = Number(original.match(/'attempt-global', 'all', 3600, (\d+)/)[1]) * 24;
    const accepted = Number(original.match(/'accepted-global', 'all', 86400, (\d+)/)[1]);
    const runs = jobs.reduce((n, j) => n + dailyRuns(j.schedule), 0);
    assert.equal(runs, 1021);
    for (const job of jobs.filter(j => !j.jobname.endsWith("history"))) {
      const batch = Number(job.command.match(/cleanup_inquiry_data\('[^']+', (\d+)\)/)[1]);
      const growth = job.jobname.endsWith("attempts") ? attempts
        : job.jobname.endsWith("rates") ? attempts * 5 + 25 : accepted;
      assert.ok(batch * dailyRuns(job.schedule) > growth, `${job.jobname} must outpace permitted growth`);
    }
    for (const job of jobs.filter(j => !j.jobname.endsWith("history"))) {
      assert.match(job.command, /set local role collabflow_maintenance/);
      await db.exec(job.command); // real cleanup under its actual runner role
    }
    const history = jobs.find(j => j.jobname.endsWith("history"));
    assert.doesNotMatch(history.command, /for\s+update|skip\s+locked/i);
    assert.ok(Number(history.command.match(/limit (\d+)/)[1]) * dailyRuns(history.schedule) > runs);
    await db.exec("update cron.job set username='cron_fixture_admin'");
    await db.query(`insert into cron.job_run_details (jobid,status,start_time,end_time)
      select $1, 'succeeded', now()-interval '8 days', now()-interval '8 days' from generate_series(1,2002)`, [history.jobid]);
    await db.query(`insert into cron.job_run_details (jobid,status,start_time,end_time) values
      ($1,'failed',now()-interval '8 days',null),
      ($1,'running',now()-interval '8 days',null),
      ($1,'failed',null,null),
      ($1,'succeeded',now(),now()),
      (999,'succeeded',now()-interval '8 days',now()-interval '8 days')`, [history.jobid]);
    await db.exec("update cron.job_run_details set username='cron_fixture_admin'");
    await db.query(`insert into cron.job_run_details (jobid,username,status,start_time,end_time)
      values ($1,'another_owner','succeeded',now()-interval '8 days',now()-interval '8 days')`, [history.jobid]);
    // A Supabase-style non-owner with SELECT/DELETE ONLY must be able to run
    // history cleanup. The former FOR UPDATE and CREATE INDEX both fail here.
    await db.exec("set role cron_fixture_admin");
    await assert.rejects(db.query("select runid from cron.job_run_details limit 1 for update"), e => e.code === "42501");
    await assert.rejects(db.exec("create index forbidden_fixture_index on cron.job_run_details(end_time)"), e => e.code === "42501");
    await db.exec("reset role");
    const historyRun = async () => {
      await db.exec("set role cron_fixture_admin");
      try { await db.exec(history.command); } finally { await db.exec("reset role"); }
    };
    const countHistory = async () => (await db.query("select count(*)::int as n from cron.job_run_details")).rows[0].n;
    await historyRun(); assert.equal(await countHistory(), 8);
    await historyRun(); assert.equal(await countHistory(), 5);
    await historyRun(); assert.equal(await countHistory(), 5);
    await db.exec("update cron.job set username=current_user");
    const monitored = await monitorRows();
    assert.equal(monitored.length, 6);
    assert.ok(monitored.every(j => !j.missing_job && !j.unexpected_schedule));
    const attemptJob = jobs.find(j => j.jobname === "collabflow-cleanup-attempts");
    const run = (await db.query(`insert into cron.job_run_details(jobid,status,start_time,end_time)
      values ($1,'failed',now(),now()) returning runid`, [attemptJob.jobid])).rows[0];
    const failed = (await monitorRows()).find(j => j.jobid === attemptJob.jobid);
    assert.equal(failed.job_state, "failed");
    assert.equal(failed.stale_success, true);
    await db.query("update cron.job_run_details set status='succeeded' where runid=$1", [run.runid]);
    const succeeded = (await monitorRows()).find(j => j.jobid === attemptJob.jobid);
    assert.equal(succeeded.job_state, "succeeded");
    assert.equal(succeeded.stale_success, false);
    await db.query("update cron.job_run_details set end_time=now()-interval '16 minutes' where runid=$1", [run.runid]);
    assert.equal((await monitorRows()).find(j => j.jobid === attemptJob.jobid).stale_success, true);
    await db.query("update cron.job_run_details set end_time=now() where runid=$1", [run.runid]);
    const latestFailure = (await db.query(`insert into cron.job_run_details(jobid,status,start_time,end_time)
      values ($1,'failed',now(),now()) returning runid`, [attemptJob.jobid])).rows[0];
    const failedAfterSuccess = (await monitorRows()).find(j => j.jobid === attemptJob.jobid);
    assert.equal(failedAfterSuccess.job_state, "failed");
    assert.equal(failedAfterSuccess.stale_success, false);
    await db.query("delete from cron.job_run_details where runid=$1", [latestFailure.runid]);
    await db.query("update cron.job set database='other_database', schedule='0 0 * * *' where jobid=$1", [attemptJob.jobid]);
    const misconfigured = (await monitorRows()).find(j => j.jobid === attemptJob.jobid);
    assert.equal(misconfigured.unexpected_database, true);
    assert.equal(misconfigured.unexpected_schedule, true);
    await db.query("update cron.job set database=current_database(), schedule=$2 where jobid=$1", [attemptJob.jobid, attemptJob.schedule]);
    await db.exec("update cron.job set jobname='temporarily-missing' where jobname='collabflow-cleanup-inquiries'");
    const missing = await monitorRows();
    assert.equal(missing.filter(j => j.missing_job && j.job_state === "not_scheduled").length, 1);
    assert.ok(missing.filter(j => j.missing_job).every(j => !j.unexpected_schedule && !j.stale_success && !j.unexpected_database));
    await db.exec("update cron.job set jobname='collabflow-cleanup-inquiries' where jobname='temporarily-missing'");
    const stop = file("supabase/operations/inquiry-cleanup-stop.sql");
    await assert.rejects(db.exec(stop), /Explicit pause approval required/);
    await db.exec("rollback; set collabflow.approve_cleanup_stop='pause-cleanup'");
    await assert.rejects(db.exec(stop), /Explicit pause approval required/);
    await db.exec("rollback; reset collabflow.approve_cleanup_stop");
    const approvedStop = stop.replace("approval constant text := 'NOT_APPROVED'",
      "approval constant text := 'pause-cleanup'");
    assert.notEqual(approvedStop, stop);
    await db.exec(`insert into cron.job(jobname,schedule,command,username) values
      ('collabflow-cleanup-unrelated','* * * * *','select 1',current_user),
      ('collabflow-cleanup-inquiries','* * * * *','select 1','another_owner')`);
    const beforeStop = (await db.query("select * from cron.job order by jobid")).rows;
    const beforeHistory = (await db.query("select * from cron.job_run_details order by runid")).rows;
    // A non-owner with SELECT still cannot see other users' jobs under RLS.
    await db.exec("set role cron_fixture_admin");
    assert.equal((await db.query("select row_security_active('cron.job'::regclass) as active")).rows[0].active, true);
    assert.equal((await db.query("select * from cron.job")).rows.length, 0);
    assert.ok((await monitorRows()).every(j => j.job_state === "not_scheduled" && j.missing_job && !j.stale_success && !j.unexpected_schedule));
    await assert.rejects(db.exec(approvedStop), /No matching CollabFlow cleanup jobs visible/);
    await db.exec("rollback; reset role");
    // An error after the first pause must roll the entire stop back.
    await db.exec(`create or replace function cron.alter_job(job_id bigint, active boolean)
      returns void language plpgsql as $$ begin
        if job_id = ${jobs[1].jobid} then raise exception 'fixture pause failure'; end if;
        update cron.job set active=$2 where jobid=$1;
      end $$;`);
    await assert.rejects(db.exec(approvedStop), /fixture pause failure/);
    await db.exec("rollback");
    assert.deepEqual((await db.query("select * from cron.job order by jobid")).rows, beforeStop);
    await db.exec(`create or replace function cron.alter_job(job_id bigint, active boolean)
      returns void language sql as $$ update cron.job set active=$2 where jobid=$1 $$;`);
    const notices = [];
    const noticeOptions = { onNotice: notice => notices.push(notice.message) };
    await db.exec(approvedStop, noticeOptions);
    await db.exec(approvedStop, noticeOptions);
    assert.equal(notices.filter(n => n.startsWith("Paused 6 CollabFlow cleanup jobs")).length, 2);
    const ownIds = new Set(jobs.map(j => j.jobid));
    assert.deepEqual((await db.query("select * from cron.job order by jobid")).rows,
      beforeStop.map(j => ownIds.has(j.jobid) ? { ...j, active: false } : j));
    assert.deepEqual((await db.query("select * from cron.job_run_details order by runid")).rows, beforeHistory);
    assert.ok((await monitorRows()).every(j => j.job_state === "paused" && !j.stale_success));
    await assert.rejects(db.exec(fixtureActivation), /owned by another administrator/);
    await db.exec("rollback");
    // Remove only the synthetic conflicting fixture, never a hosted job.
    await db.exec("delete from cron.job where username='another_owner'");
    await db.exec(fixtureActivation);
    assert.deepEqual((await db.query("select * from cron.job order by jobid")).rows.filter(j => ownIds.has(j.jobid)), jobs);
  });
});
