-- Read-only; pg_cron must be installed. Run this file once in SQL Editor as
-- the scheduling administrator: the sole active SELECT returns all six jobs.
-- No prior session state or temporary objects are needed. Not-yet-scheduled
-- jobs appear as not_scheduled, not as an empty result. Check viewer_role if
-- the expected jobs appear missing. Optional diagnostics below are commented
-- out so they cannot replace the job-status grid with a different result.
-- This overview is scoped to current_user. pg_cron RLS may hide other owners;
-- not_scheduled means absent from this owner's view, not absent globally.
with expected(jobname, schedule, tolerance) as (values
  ('collabflow-cleanup-attempts', '*/5 * * * *', interval '15 minutes'),
  ('collabflow-cleanup-rates', '1-59/2 * * * *', interval '10 minutes'),
  ('collabflow-cleanup-receipts', '11 */6 * * *', interval '8 hours'),
  ('collabflow-cleanup-tokens', '13 */6 * * *', interval '8 hours'),
  ('collabflow-cleanup-inquiries', '17 */6 * * *', interval '8 hours'),
  ('collabflow-cleanup-history', '43 3 * * *', interval '26 hours')
)
select statement_timestamp() as checked_at, current_user as viewer_role,
  e.jobname, j.jobid, e.schedule as expected_schedule, j.schedule, j.active, j.username, j.database,
  case when j.jobid is null then 'not_scheduled'
    when not j.active then 'paused'
    when last_run.status is null then 'not_run'
    else last_run.status end as job_state,
  j.jobid is null as missing_job,
  j.jobid is not null and j.schedule is distinct from e.schedule as unexpected_schedule,
  j.jobid is not null and j.database is distinct from current_database() as unexpected_database,
  last_run.status, last_run.start_time, last_run.end_time,
  last_success.end_time as last_success_at,
  j.jobid is not null and j.active and
    (last_success.end_time is null or last_success.end_time < now()-e.tolerance) as stale_success
from expected e left join cron.job j on j.jobname=e.jobname and j.username=current_user
left join lateral (select status, start_time, end_time from cron.job_run_details d
  where d.jobid=j.jobid order by runid desc limit 1) last_run on true
left join lateral (select end_time from cron.job_run_details d
  where d.jobid=j.jobid and status='succeeded' order by runid desc limit 1) last_success on true
order by e.jobname;

/* OPTIONAL READ-ONLY DIAGNOSTICS
Select and run one query below separately when needed. These are not required
for the six-job overview. Exact backlog counts can be expensive on large tables.
select 'inquiry_attempts' as table_name, count(*) as expired, min(expires_at) as oldest_deadline from collabflow_private.inquiry_attempts where expires_at <= now()
union all select 'inquiry_rates', count(*), min(expires_at) from collabflow_private.inquiry_rates where expires_at <= now()
union all select 'inquiry_receipts', count(*), min(expires_at) from collabflow_private.inquiry_receipts where expires_at <= now()
union all select 'inquiry_tokens', count(*), min(expires_at) from collabflow_private.inquiry_tokens where expires_at <= now()
union all select 'collaboration_inquiries', count(*), min(retention_due_at) from collabflow_private.collaboration_inquiries
where retention_due_at <= now() and created_at <= now()-interval '180 days'
  and created_at >= (select retention_effective_at from collabflow_private.inquiry_settings where singleton);

select j.jobname, d.status, count(*) as runs, min(d.start_time) as oldest_run,
  count(*) filter (where d.start_time is null and d.end_time is null) as undated_runs
from cron.job_run_details d join cron.job j on j.jobid=d.jobid
where j.username=current_user and j.jobname like 'collabflow-cleanup-%'
group by j.jobname, d.status order by j.jobname, d.status;
select relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
from pg_stat_user_tables where schemaname='collabflow_private' or (schemaname='cron' and relname='job_run_details');
select pg_size_pretty(pg_total_relation_size('cron.job_run_details')) as cron_history_size,
  count(*) as all_job_history_rows from cron.job_run_details;
select has_table_privilege(current_user, 'cron.job_run_details', 'select') as can_read_history,
  has_table_privilege(current_user, 'cron.job_run_details', 'delete') as can_delete_history;
*/
