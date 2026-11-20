# Milestone 2A.2B: inquiry retention and cleanup

## Scope and rollout state

The retention migration is now applied, according to the project owner. The operations scripts remain explicitly opt-in, and **no production cleanup jobs are scheduled**. This agent performed only local code/documentation changes and verification; it did not connect to the hosted database, apply migrations, install extensions, activate Cron, change environments, commit, push, deploy, or enable inquiries. The creator inbox remains M2A.3.

The user reports that migration `20261119000300_collaboration_inquiries.sql` was already applied manually, the restricted writer passed its privilege checks, and pooler connections validate TLS. Production variables are configured with `INQUIRIES_ENABLED=false`. These are user-provided operational results, not checks repeated by this milestone. **Do not reapply that migration or run `supabase db push`.** Its contents are unchanged.

## Hosted verification reported by the project owner (2026-11-20)

These results were confirmed to the agent by the owner; they were not independently repeated or inspected by the agent. No hosted credentials or secret values were retrieved.

| Check | Owner-reported result |
| --- | --- |
| Retention migration 20261120000100 | Applied successfully; do not modify or reapply |
| Retention setting | `retention_days = 180` |
| Policy boundary | `retention_effective_at = 2026-11-20 06:59:45 UTC` |
| Private tables | All six have FORCE RLS |
| Roles and ownership | Cleanup roles and function ownership verified |
| Content access | Cleanup executor cannot read inquiry email or message |
| Application access | Application roles cannot execute cleanup |
| Cron extension | pg_cron 1.6.4 installed; Cron permissions verified |
| Scheduler smoke test | Temporary `SELECT 1` job succeeded and was removed |
| Maintenance-role calls | All five cleanup targets tested inside a transaction followed by ROLLBACK; each returned zero |
| Expired data | None found during the reported checks |
| Production cleanup jobs | None scheduled |
| Inquiry feature | `INQUIRIES_ENABLED=false` |

The repository exposes one parameterized cleanup function for five table targets. The five reported maintenance-role checks cover those paths. Zero-result calls establish permission/callability against the current dataset, not deletion behavior under load or concurrent locks. The temporary Cron success establishes scheduler execution, not successful execution of the six production cleanup jobs.

Still pending: explicit production cleanup approval/activation, observation of the actual scheduled commands and history cleanup, multi-session locking validation, representative backlog/load and storage-capacity validation, monitoring/alert ownership, and the privacy/backup-policy rollout checks. Expired-row deletion, boundary behavior and restrictive permissions have local PGlite regression coverage; that evidence is separate from hosted checks.

## Policy and existing records

The [applied retention migration](../supabase/migrations/20261120000100_inquiry_retention.sql) sets the existing singleton's `retention_days` to **180**. Existing intake already calculates `retention_due_at` from this setting; its behavior and API need no changes. Deadlines are stored as timestamps; cleanup uses the stored deadline, not the current setting. Operate in UTC, as in Supabase's default configuration.

An insert-blocking table lock establishes `retention_effective_at`. No existing inquiry is updated or backfilled. Records created before this boundary, and all records with NULL deadlines, are excluded from automatic inquiry cleanup even if an old non-NULL deadline has passed. The migration rejects future-dated existing records instead of silently enrolling them. Transactions already in flight can retain the old policy if they read it before migration completion; NULL deadlines remain protected and are visible in preflight. Keep intake disabled during migration and inspect the cohort afterward.

Do not move the cohort boundary backward or backfill existing records as routine maintenance. A separate explicit review must decide their disposition. Consequently, existing records with no deadline can remain indefinitely until that review. Creator account deletion retains its existing cascade behavior, and unpublishing does not delete inquiries.

The disabled public form now contains this disclosure:

> Your inquiry is scheduled for deletion from CollabFlow's active database after 180 days. Deletion happens during scheduled cleanup and may take longer if maintenance is delayed. Backup copies follow the backup retention policy.

This describes active-database retention, not an exact deletion SLA or deletion from backups or a recipient's separate copies. Before enabling inquiries, activate and observe cleanup, publish the applicable privacy/backup policy, and confirm the provider's actual backup/PITR retention. This milestone does not invent a backup lifetime or alter backup settings. The form's existing feature gate remains unchanged.

## Cleanup architecture and privileges

`collabflow_private.cleanup_inquiry_data(table_name, batch_size)` accepts only five fixed table names and integer batch sizes 1–2,000. Each call deletes at most one batch from one table. A materialized candidate query orders by expiry, locks rows using `FOR UPDATE SKIP LOCKED`, and deletes those exact primary keys within the caller's transaction. Every expiry comparison uses the database's statement timestamp. Both the candidate query and RLS also enforce an independent 180-day age floor, so an accidentally early stored deadline cannot shorten inquiry retention. There is no caller-supplied cutoff, unbounded delete, network call, or retry loop inside the function. Retrying drains further eligible rows; once drained it returns zero.

Independent workers skip rows held by another cleanup or intake transaction. An aborted transaction rolls back its deletions; later runs can reclaim them. The inquiry deadline index is new; the four existing technical expiry indexes are reused. Legacy inquiries are additionally filtered by the policy cohort. An administrator should review query plans with representative legacy/backlog volume before rollout; a deletion limit bounds writes, not necessarily the number of index entries examined.

| Data | Earliest eligibility | Preserved guarantee |
| --- | --- | --- |
| Inquiry | Stored 180-day deadline, only the new cohort | Never delete earlier or enroll legacy/NULL rows |
| Attempt | `expires_at`, normally two minutes | Unexpired tickets remain usable |
| Rate bucket | `expires_at`, window end plus one day | No counter reset within an active rate window |
| Receipt | `expires_at`, normally 24 hours | At least 24-hour idempotent retry window |
| Token ledger | `expires_at`, normally 24 hours | At least 24-hour local replay window |

After a receipt expires and is removed, the same submission UUID can eventually create a new inquiry; retries are not promised to deduplicate forever. Receipts and token rows can outlive expiry until the next successful sweep, making protection conservatively longer.

The function is SECURITY DEFINER, owned by `collabflow_cleanup_executor`: NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, no role/database creation or replication. It owns no tables and has no schema CREATE. It gets only required key/deadline SELECT columns, DELETE, and deadline-column UPDATE for row locking. SELECT/DELETE policies restrict visibility/deletion to eligible records; the UPDATE policy has `WITH CHECK(false)` to prohibit actual updates. It cannot read sender names, addresses, company, or message content. All tables retain ENABLE and FORCE RLS.

`collabflow_maintenance` is a separate NOLOGIN, unprivileged role with schema USAGE and function EXECUTE only. Only the migration administrator receives membership so Cron can `SET LOCAL ROLE` to it. The definer has an empty search path and schema-qualified application references; default PUBLIC EXECUTE is revoked. No application role gets DELETE, TRUNCATE, cleanup EXECUTE, or membership in either new role. No cleanup endpoint or exposed public-schema function is added. Verify that `collabflow_private` remains excluded from PostgREST's exposed schemas.

Cron schedules as the migration administrator because jobs run as their scheduling user. Each data-cleanup command immediately starts a transaction, sets a 15-second statement timeout and two-second lock timeout, switches to the execute-only maintenance role, invokes one batch, then commits. The history job uses the scheduling administrator's existing Cron privileges, with explicit ownership and exact job-name predicates. It grants no additional Cron privileges. Database administrators remain trusted and can bypass these application boundaries.

## Schedule and capacity

The [activation script](../supabase/operations/inquiry-cleanup-activate.sql) creates **six** jobs only after explicit opt-in:

| Job | Schedule | Batch | Nominal daily deletion capacity |
| --- | --- | ---: | ---: |
| Attempts | Every five minutes | 2,000 | 576,000 |
| Rate buckets | Every two minutes, odd minutes | 2,000 | 1,440,000 |
| Receipts | Every six hours, minute 11 | 1,000 | 4,000 |
| Tokens | Every six hours, minute 13 | 1,000 | 4,000 |
| Inquiries | Every six hours, minute 17 | 500 | 2,000 |
| Cron history | Daily at 03:43 (Cron timezone) | 2,000 | 2,000 |

The existing global preflight quota permits 10,000 attempts per fixed hour, or 240,000 per day. Each can allocate at most two IP preflight buckets and three accepted-stage buckets; accepted-stage denials still allocate/count these. Thus the conservative sustained bound is **50,000 rate rows/hour, plus one hourly and one daily global bucket**, roughly 1.2 million/day. The rate sweeper's 60,000/hour capacity exceeds this bound by about 20%. Attempt capacity is 2.4 times sustained creation. The accepted global limit bounds new inquiries, receipts and tokens at 1,000/day, below their cleanup capacities. Inquiries can approach 180,000 retained records plus boundary/cleanup backlog; rate metadata's maximum lifetime is almost 48 hours, giving a conservative envelope near 2.4 million rows plus lag. Review storage sizing and autovacuum at this envelope.

Fixed-window boundaries permit bursts; finishing tickets can spill two minutes into the next window. The capacity figures are sustained bounds, not promises to drain every burst in one run. The revised schedule produces **1,021 history rows/day**, down from 5,808 (about 82% fewer job starts). Retain seven days of completed history; daily 2,000-row deletion exceeds new history growth. Running/starting records and other jobs' history are preserved. Old history for previously unscheduled jobs cannot be mapped by name: inventory it separately, never perform a blanket history delete.

History cleanup requires only SELECT on `cron.job` and SELECT/DELETE on `cron.job_run_details`, matching upstream pg_cron grants and Supabase's documented history-cleanup operation. It does **not** create indexes, modify extension objects, grant privileges, or use `FOR UPDATE` (which would require unavailable UPDATE privilege). The candidate query orders by the existing `runid` primary key and limits deletion to 2,000. Ordinary DELETE row locks handle overlapping callers; a competing run may time out and retry later without double deletion. pg_cron itself serializes instances of one job. Scans can still be costly when other jobs have large histories; timeouts and history-size monitoring remain necessary. A non-owner SELECT/DELETE-only regression test exercises the actual history SQL.

Undated terminal history (both timestamps NULL, possible with older pg_cron failure paths) is preserved because its age cannot be established. Monitoring exposes these rows; alert on any occurrence and obtain a separate provider-version/manual-history review. Do not infer age from run IDs or automatically erase undated failures. This and orphaned/other-job history need an explicit operational owner.

Actual throughput depends on database size, load, locks, and provisioned resources. Before public activation, test these batches on a representative staging dataset, verify each normally completes well below 15 seconds and the backlog trends down, and reserve capacity for other Cron jobs. A failing/paused scheduler cannot enforce retention; alerting and an on-call owner are required. Do not silently raise the batch ceiling, quotas, or scheduler frequency without a capacity review. With the reduced rate schedule, sustained failures above roughly one sixth of scheduled runs exhaust rate-cleanup headroom; alert before that point.

**Supabase Free limitation:** the [published Free plan](https://supabase.com/pricing) includes a 500 MB database and may pause after a week of inactivity. At the existing maximum of 1,000 accepted inquiries/day, 180 days can retain 180,000 proposals; at the allowed 20 KB message ceiling that is up to 3.6 GB of logical message data alone, before indexes and metadata (actual compression varies). Therefore no cleanup schedule can guarantee that all traffic permitted by the existing caps fits Free while preserving 180 days. These schedules reduce idle overhead and outpace bounded row growth when jobs run, but are suitable for Free only at measured low traffic. Keep the 180-day floor and retry windows; require an explicitly approved capacity upgrade or quota reduction before approaching the storage envelope. Alert on storage headroom and project availability; a paused database cannot execute cleanup.

## Read-only preflight (before any activation)

Run the complete [preflight SQL](../supabase/operations/inquiry-retention-preflight.sql) as the database administrator. It is read-only and works both before and after this new migration. Its initial required summary is:

```sql
select count(*) as total_inquiries,
  count(*) filter (where retention_due_at is null) as without_retention_due_at,
  count(*) filter (where retention_due_at <= statement_timestamp()) as past_retention_deadline
from collabflow_private.collaboration_inquiries;
```

Record aggregate results; do not export inquiry contents. After migration, verify the retention setting is 180, the cohort boundary is present, existing row counts are unchanged, and legacy records remain excluded. Review the supplied policy/index/owner/ACL/role queries. All application DELETE/TRUNCATE and cleanup EXECUTE results must be false. Both cleanup roles must have all elevated flags false, no schema CREATE, and no table ownership. Only the migration administrator may be a member of maintenance; no application role may inherit either role. Audit any preexisting cluster-wide default grants separately.

Before Cron activation, with pg_cron already installed under separate approval, also run:

```sql
select extversion from pg_extension where extname = 'pg_cron';
select jobid, jobname, schedule, active, username, database from cron.job;
select count(*) as history_rows,
  pg_size_pretty(pg_total_relation_size('cron.job_run_details')) as history_size
from cron.job_run_details;
select indexname, indexdef from pg_indexes where schemaname='cron';
select current_setting('cron.timezone', true) as cron_timezone,
  current_setting('cron.max_running_jobs', true) as max_running_jobs;
```

These queries disclose no connection secrets. Review visible job-name conflicts, available job slots, scheduling user, SELECT/DELETE extension permissions, undated failures, and history size. Large preexisting history may need separately approved bounded maintenance; never alter Supabase-managed objects. The activation script has lock and statement timeouts and rolls back on errors. It installs no extensions.

## Migration reference for other environments only

**The current project already has migrations 003 and 20261120000100. Do not rerun either.** The following steps are retained only for a different environment that has not received the retention migration.

1. Keep inquiries disabled. Review the retention migration and save preflight aggregates. Confirm the database matches migrations 001–003, including the already-applied 003; never reapply those files.
2. After explicit approval, apply **only** `20261120000100_inquiry_retention.sql` using the approved administrative migration process. The transaction changes settings, adds an index, policies and roles/function; it does not call cleanup or schedule anything. It is a single-application migration: an accidental rerun fails atomically without moving the cohort boundary; only the operational scripts are designed for repeat execution. A lock timeout requires investigating/retrying in a quiet window, not removing safeguards.
3. Repeat read-only preflight. Confirm 180, the correct boundary, no changed/deleted existing inquiry rows, intended owners/grants, and forced RLS. Reconcile the manually applied migration in the team's migration ledger through a separately reviewed process; do not run a bulk push.
4. Run staging functional, privilege, concurrency and capacity validation before considering scheduling or product activation. Application deployment and enabling inquiries remain separate decisions.

## Eventual Cron activation: separate explicit approval

1. The current project's migration, pg_cron installation, permissions and basic scheduler test are owner-reported complete. Review the remaining rollout gates above and obtain explicit approval for the six production jobs. Use the migration administrator and intended database; do not reinstall the extension or reapply migrations.
2. Open [inquiry-cleanup-activate.sql](../supabase/operations/inquiry-cleanup-activate.sql) in the Supabase SQL Editor. In this execution copy only, change the declaration inside the first DO block from:

   ```sql
   approval constant text := 'NOT_APPROVED';
   ```

   to:

   ```sql
   approval constant text := 'reviewed-180-day-policy-and-cleanup';
   ```

3. Run the **entire script in one execution**, including BEGIN, approval guard, scheduling and COMMIT. Do not execute a separate SET command or select only the scheduling fragment. Approval is a block-local constant: no connection/session persistence is needed, and stale settings from a pooled connection cannot authorize the default script. The version-controlled file stays NOT_APPROVED. On an SQL error the transaction is aborted; if the editor retains that connection in an aborted transaction, run ROLLBACK before a complete retry.
4. Scheduling is transactional; named jobs for the same scheduling user update on rerun and are explicitly reactivated without duplicate IDs. This starts deletion according to the documented schedules. Existing legacy inquiries remain protected. Run [monitoring SQL](../supabase/operations/inquiry-cleanup-monitor.sql) and observe the actual jobs after activation; do not infer success from the earlier SELECT 1 test or zero-row dry runs. Do not enable inquiries automatically. No approval-setting reset is needed.

Cron ownership and visibility: pg_cron applies an owner-based RLS policy to `cron.job`. SELECT permission alone does not reveal other users' jobs. Activation checks visible foreign-owned conflicts and emits a NOTICE when RLS is active; passing that check does not prove global uniqueness. The monitor intentionally filters to `current_user` even for a privileged observer, so `not_scheduled` means absent from that user's view. Use the original scheduling administrator. Any cross-owner audit must be performed separately by an operator whose effective privileges actually permit it; these scripts neither bypass RLS nor grant broader access. See [pg_cron 1.6.4 policy definition](https://github.com/citusdata/pg_cron/blob/v1.6.4/pg_cron.sql).

## Monitoring, failures and rollback

Run the complete [monitoring script](../supabase/operations/inquiry-cleanup-monitor.sql) in one SQL Editor execution as the scheduling administrator. Its single active SELECT returns exactly six ordered rows with viewer role, expected/actual schedule, job state, latest execution and last successful execution. Before activation, all six should show `not_scheduled` with `missing_job=true`; that is the expected current state. Missing jobs do not trigger `unexpected_schedule`, `unexpected_database`, or `stale_success`. Existing jobs flag `unexpected_database` when their target differs from `current_database()`. Active jobs with no successful run or an overdue success flag `stale_success`; paused jobs suppress that flag. Latest failed runs remain visible even if a recent successful run exists. After registration, `not_run` indicates no recorded execution yet; `paused` indicates a disabled job. Optional backlog/history/storage queries are in a block comment: select and run an individual diagnostic only when needed, so it does not replace the main status grid. The script has no writes, temporary objects or required prior session settings.

Use this read-only monitoring in an independently monitored operational check. A SQL file alone does not send alerts: assign an owner and configure an external alert/scheduled review before activation. Alert on any failed job, inactive/missing job, changed schedule or target database, or run still running after one minute. The monitor always returns the six expected job names, including missing jobs. Stale-success thresholds are 10 minutes for rates, 15 minutes for attempts, eight hours for receipts/tokens/inquiries, and 26 hours for history. Inspect Cron run errors in the administrative dashboard; do not publish raw database errors. Cron's successful SELECT result does not reliably report the returned deletion count, so use expired backlog counts/oldest deadlines and run durations rather than treating "1 row" as one deletion.

Alert if expired attempt/rate backlog fails to decline across an hour or its oldest expiry exceeds two hours; alert if receipts/tokens/inquiries lag more than eight hours, or terminal history remains beyond nine days. Also alert on undated terminal records immediately. These are initial operational thresholds, not a user-facing deletion SLA. Exact counts can be expensive on a large backlog; use indexed oldest-expiry probes more frequently and full counts less often. Check disk usage, dead tuples, autovacuum/analyze recency, and all other Cron job history; deletion does not itself shrink physical table files. Do not run VACUUM FULL during normal service.

For failure: inspect permissions, table/index health, lock waits and resource pressure. A failed transaction rolls back its batch. Correct the issue and let the next bounded run retry. For catch-up, repeat individual bounded calls in **separate transactions** only after approval and measurement; never wrap many calls in one giant transaction.

For an approved emergency pause, open [inquiry-cleanup-stop.sql](../supabase/operations/inquiry-cleanup-stop.sql) in the SQL Editor as the original scheduling administrator. Change its block-local declaration from `approval constant text := 'NOT_APPROVED';` to `approval constant text := 'pause-cleanup';` in the execution copy, then run the entire script once, including BEGIN and COMMIT. No separate SET execution or persistent session is required; the checked-in script remains fail-closed. It deactivates only the six jobs owned by that user and retains IDs/history. It raises an exception if zero matching jobs are visible and reports the number successfully set inactive through a NOTICE (including already-paused jobs on retries). Read the SQL Editor messages and confirm COMMIT succeeds: any pause error rolls back the whole operation. A partial set reports its actual count; use the six-row monitor to identify missing jobs. It is repeatable when matching jobs exist. Do not unschedule or drop the extension: retain history attribution and other applications' jobs. Inspect ongoing runs; pausing does not cancel them, though each command has a 15-second timeout. Cancel a running cleanup backend only after explicitly identifying that job and approving that intervention. Run the monitoring script afterward and confirm all six existing jobs report `paused`. No session-setting reset is needed. Jobs not yet scheduled remain `not_scheduled`; jobs owned by another role are intentionally untouched.

Operational rollback stops future deletion; it cannot undo committed deletes. Keep the policy setting and cohort boundary in place. Restoring data or changing 180 days requires a separate reviewed forward migration/recovery plan; never edit the already-applied migration or automatically restore expired personal data. Resume only through the reviewed activation script after fixing the cause. If all six jobs are paused, new history stops; monitor existing/stuck rows separately.

## Local verification and limitations

[Retention tests](../tests/inquiry-retention.test.mjs) run the SQL in disposable PGlite databases: unchanged legacy records, expiration/boundaries, bounded/idempotent deletion, RLS/ACLs, invalid inputs, restricted content access, SQL preflight, activation refusal, repeatable registration/pause, and bounded/scoped history cleanup. A scheduler fixture executes the actual scheduled SQL but does not simulate a pg_cron worker. It now models extension-owned history and executes cleanup as a non-owner with SELECT/DELETE only, verifies ownership/age scoping and missing-job monitoring, and checks schedule capacity against the intake quota constants. [Intake regressions](../tests/inquiries-database.test.mjs) run both before and after retention migration, including M1/M2A.1 SQL assertions and retry/replay windows surviving cleanup.

[Multi-session tests](../tests/integration/inquiry-cleanup.postgres.mjs) require an explicitly supplied `COLLABFLOW_CLEANUP_TEST_DATABASE_URL` for a disposable **numeric-loopback** PostgreSQL superuser. They never load environment files, reject remote hosts/query overrides, create a uniquely named database and per-run roles, and clean up only those generated objects. They hold one expired row locked while two uncommitted cleanup sessions run, then commit one and roll back the other, proving skip-locked progress, disjoint batches and recovery. Run with `npm.cmd run test:cleanup:postgres`. Without that target, the test explicitly skips; PGlite's single connection cannot prove simultaneous-session behavior. Basic hosted scheduler/permission checks are now owner-reported complete. Actual production-job execution, multi-session locking and representative load validation remain rollout gates.

Use the established source-copy procedure for Next build/HTTP tests: fresh ignored `.next/validation-m2a2b`, explicit source/config allowlist, installed dependency junction, no existing environment files, newly written dummy public configuration only. Unit/lint/type checks run at the repository root without dotenv. Do not run Next at the original root while local environment-file access is prohibited.

Implementation verification completed on 2026-11-20 (build/HTTP results below are from the preceding implementation pass, not rerun for this SQL/documentation-only readiness update):

| Command/check | Result |
| --- | --- |
| `npm.cmd test` | PASS: 173 tests, including PGlite SQL, M1/M2A.1 and intake regressions |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run build` in `.next/validation-m2a2b` | PASS: default Turbopack production build, 18 static-generation entries |
| `npm.cmd run test:http` in the isolated copy | PASS: 23 HTTP tests, including disclosure and synthetic enabled/disabled configurations |
| `npm.cmd run test:cleanup:postgres` | SKIPPED: one multi-session test; no disposable loopback PostgreSQL configured, no local PostgreSQL/Docker executable found |
| Editor diagnostics; `git diff --check` | PASS |

The SQL tests verified actual RLS/grants, protected legacy records, early-deadline defense, the 180-day boundary, 2,000-row batching, invalid identifiers, and repeatable cleanup. The Cron fixture verified activation refusal, schedule capacity, repeat activation/pause, missing-job monitoring, and scoped history deletion by a non-owner with SELECT/DELETE only. It explicitly demonstrated that the previous FOR UPDATE/index operations are denied under those permissions. The fixture is local evidence only. The owner subsequently reported hosted permission checks, a successful temporary Cron job and rollback-protected zero-row cleanup calls. Actual production cleanup jobs and representative load/concurrency validation remain pending.

The first expanded static assertion mistakenly matched a comment about forbidden index creation; it was corrected to inspect SQL statements, and the full suite subsequently passed. Existing non-failing Node module-type, Next partial-prefetching, and nested-copy workspace-root warnings remain. The editor task tool returned `No invocation context`; the build therefore used the terminal in the isolated copy. No dependency installation was needed.

The operational-readiness follow-up reran `node --test tests/inquiry-retention.test.mjs` (15 passing tests), `npm.cmd test` (173 passing tests), `npm.cmd run typecheck`, and `npm.cmd run lint`; all passed. The optional PostgreSQL command again skipped its one multi-session test because no disposable loopback server was configured. Editor diagnostics and `git diff --check` passed. New assertions cover rejection despite stale approval session settings, single-execution approval, six-row read-only monitoring before/after scheduling and pausing, and repeated pauses preserving job IDs, history and unrelated jobs. Build and HTTP tests were not rerun for this SQL/documentation-only follow-up.

Both applied migrations remained unchanged: M2A.2 SHA-256 `737f4d10f756f4a5885d90995524609f73c31109c2ccd4f11808905ce1383e4c`; retention migration SHA-256 `e04e5f52f304c4b7c222355cd870ecbe2377aaac964eba63961ce61f606879d3`. Existing environment files were neither read nor changed. No agent-initiated hosted database/settings/feature activation, commit, push or deployment occurred; hosted operations reported by the owner are recorded separately above.

## File inventory

Created:

- [Retention migration](../supabase/migrations/20261120000100_inquiry_retention.sql).
- [Read-only preflight](../supabase/operations/inquiry-retention-preflight.sql), [opt-in activation](../supabase/operations/inquiry-cleanup-activate.sql), [monitoring](../supabase/operations/inquiry-cleanup-monitor.sql), and [opt-in stop](../supabase/operations/inquiry-cleanup-stop.sql).
- [Retention/operations regression tests](../tests/inquiry-retention.test.mjs) and [optional multi-session PostgreSQL tests](../tests/integration/inquiry-cleanup.postgres.mjs).
- This runbook.

Updated existing local work:

- [Intake database regressions](../tests/inquiries-database.test.mjs) run with original and new retention policies.
- [Public form](../components/inquiry-form.tsx) and [HTTP tests](../tests/integration/public-profiles.http.mjs) include the disabled-feature retention disclosure.
- [Package scripts](../package.json) add the optional local PostgreSQL test command; no dependency changes.
- [README](../README.md) and [M2A.2 guide](./milestone-2a-2.md) link the new policy and distinguish the migration from the pending operations. Earlier README/M2A.2 rollout notes predate the owner-reported retention migration application; the current status at the top of this runbook supersedes them.

## Upstream references

- [pg_cron documentation](https://github.com/citusdata/pg_cron): scheduling-user permissions, named jobs, job-run history and its lack of automatic cleanup.
- [Supabase Cron](https://supabase.com/docs/guides/cron): platform integration and operational guidance; confirm project-specific extension availability separately.
- [pg_cron history table grants](https://github.com/citusdata/pg_cron/blob/main/pg_cron--1.2--1.3.sql): SELECT/DELETE, with owner-scoped RLS; no UPDATE grant.
- [Supabase Cron quickstart](https://supabase.com/docs/guides/cron/quickstart): documented history cleanup through DELETE.
- [Supabase pricing](https://supabase.com/pricing): Free database size and inactivity pause limits.

### Final operational safety refinement

The stop script now rejects zero visible matches and reports the actual pause count. Monitoring suppresses missing-job false alarms and flags wrong target databases. Regression fixtures now enable owner-based RLS on Cron jobs, exercise a restricted observer, verify rollback after a mid-pause error, and assert pause notices and missing/fresh/stale/failed/paused monitoring states. No applied migration or hosted state was changed.

Verification for this refinement: focused retention suite 15/15 passed; `npm.cmd test` 173/173 passed; `npm.cmd run lint` and `npm.cmd run typecheck` passed. `npm.cmd run test:cleanup:postgres` explicitly skipped one test because no disposable local PostgreSQL was configured. The first notice-capture assertion failed because its callback was attached to PGlite construction instead of execution; after using the supported execution option, the focused and full suites passed. Build/HTTP checks were not rerun for this SQL/docs/test-only refinement.
