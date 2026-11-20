-- OPT-IN ONLY. Never run as part of application startup or migrations.
-- Read docs/milestone-2a-2b.md and the preflight first. pg_cron must already
-- be installed through a separately approved administrative operation.
-- SQL Editor: after approval, change the approval value below from NOT_APPROVED
-- to reviewed-180-day-policy-and-cleanup in your execution copy. Select/run
-- this ENTIRE script once, including BEGIN, the guard, and COMMIT.
-- No setting from another SQL Editor execution is consulted or required.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ declare approval constant text := 'NOT_APPROVED'; begin
  if approval is distinct from 'reviewed-180-day-policy-and-cleanup' then
    raise exception 'Cleanup activation requires explicit review and opt-in';
  end if;
  if not exists (select 1 from pg_extension where extname='pg_cron') then
    raise exception 'pg_cron must be installed separately after approval';
  end if;
  if not has_table_privilege(current_user, 'cron.job', 'select')
    or not has_table_privilege(current_user, 'cron.job_run_details', 'select')
    or not has_table_privilege(current_user, 'cron.job_run_details', 'delete') then
    raise exception 'Cron history SELECT/DELETE permissions require administrator review';
  end if;
  if current_user <> pg_get_userbyid((select relowner from pg_class where oid='collabflow_private.inquiry_settings'::regclass)) then
    raise exception 'Activate as the migration administrator';
  end if;
  if not exists (select 1 from collabflow_private.inquiry_settings where singleton and retention_days=180 and retention_effective_at is not null) then
    raise exception 'Retention migration/policy has not passed review';
  end if;
  if exists (
    select 1 from unnest(array['anon','authenticated','service_role','collabflow_inquiry_writer','collabflow_inquiry_executor']) r
    cross join unnest(array['collaboration_inquiries','inquiry_attempts','inquiry_rates','inquiry_receipts','inquiry_tokens']) t
    where has_table_privilege(r, 'collabflow_private.' || t, 'delete,truncate')
      or has_function_privilege(r, 'collabflow_private.cleanup_inquiry_data(text,integer)', 'execute')
  ) then raise exception 'Unexpected application cleanup privileges'; end if;
  -- SELECT privileges do not imply visibility of other owners under pg_cron
  -- RLS. This is a visible-conflict check, not proof of global uniqueness.
  -- Keep the original scheduling administrator; review other owners separately
  -- with an operator whose privileges actually permit that inspection.
  if row_security_active('cron.job'::regclass) then
    raise notice 'Cron RLS is active: foreign-owned jobs may be hidden; conflict checks cover visible rows only';
  end if;
  if exists (select 1 from cron.job where username<>current_user and jobname in (
    'collabflow-cleanup-attempts','collabflow-cleanup-rates','collabflow-cleanup-receipts',
    'collabflow-cleanup-tokens','collabflow-cleanup-inquiries','collabflow-cleanup-history')) then
    raise exception 'Visible cleanup job name is owned by another administrator';
  end if;
end $$;

-- Do not create indexes, change ACLs, or alter Supabase-managed Cron objects.

do $$ declare item record; command text; begin
  for item in select * from (values
    ('collabflow-cleanup-attempts', '*/5 * * * *', 'inquiry_attempts', 2000),
    ('collabflow-cleanup-rates', '1-59/2 * * * *', 'inquiry_rates', 2000),
    ('collabflow-cleanup-receipts', '11 */6 * * *', 'inquiry_receipts', 1000),
    ('collabflow-cleanup-tokens', '13 */6 * * *', 'inquiry_tokens', 1000),
    ('collabflow-cleanup-inquiries', '17 */6 * * *', 'collaboration_inquiries', 500)
  ) as jobs(name, schedule, target, batch) loop
    command := format('begin; set local statement_timeout = ''15s''; set local lock_timeout = ''2s''; set local role collabflow_maintenance; select collabflow_private.cleanup_inquiry_data(%L, %s); commit;', item.target, item.batch);
    -- Named scheduling updates this administrator's existing job on rerun.
    perform cron.schedule(item.name, item.schedule, command);
  end loop;
end $$;

-- History runs as the scheduling administrator, restricted in SQL to completed
-- runs of these six jobs owned by that administrator. No new cron ACL grants.
-- Keep paused jobs registered, so their history retains its ownership mapping.
-- SELECT FOR UPDATE would require UPDATE privileges that pg_cron does NOT
-- grant to its users. The bounded DELETE itself locks target rows. A competing
-- delete either finds them already removed or waits up to the lock timeout;
-- no early deletion or double side effect results. pg_cron serializes runs of
-- this same job. Order by the existing runid primary key; no extension DDL.
select cron.schedule('collabflow-cleanup-history', '43 3 * * *', $job$
  begin;
  set local statement_timeout = '15s';
  set local lock_timeout = '2s';
  with batch as materialized (
    select d.runid from cron.job_run_details d join cron.job j on j.jobid=d.jobid
    where j.username=current_user and d.username=current_user
      and j.jobname in ('collabflow-cleanup-attempts', 'collabflow-cleanup-rates',
        'collabflow-cleanup-receipts', 'collabflow-cleanup-tokens',
        'collabflow-cleanup-inquiries', 'collabflow-cleanup-history')
      and d.status in ('succeeded', 'failed')
      and coalesce(d.end_time, d.start_time) < statement_timestamp()-interval '7 days'
    order by d.runid
    limit 2000
  ) delete from cron.job_run_details d using batch b where d.runid=b.runid;
  commit;
$job$);
do $$ declare job record; begin
  for job in select jobid from cron.job where username=current_user and jobname in (
    'collabflow-cleanup-attempts','collabflow-cleanup-rates','collabflow-cleanup-receipts',
    'collabflow-cleanup-tokens','collabflow-cleanup-inquiries','collabflow-cleanup-history') loop
    perform cron.alter_job(job.jobid, active := true);
  end loop;
end $$;
commit;
