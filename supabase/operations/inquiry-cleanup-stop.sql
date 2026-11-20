-- Administrative operational rollback: stop future runs; retain history and
-- job IDs. This cannot restore deleted data or cancel a transaction in flight.
-- SQL Editor: after pause approval, change NOT_APPROVED to pause-cleanup in
-- your execution copy, then run this ENTIRE script once. No prior SET needed.
-- Execute as the same administrator that scheduled the jobs.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ declare job record; paused_count integer := 0;
  approval constant text := 'NOT_APPROVED'; begin
  if approval is distinct from 'pause-cleanup' then
    raise exception 'Explicit pause approval required';
  end if;
  for job in select jobid from cron.job where username=current_user and jobname in (
    'collabflow-cleanup-attempts', 'collabflow-cleanup-rates',
    'collabflow-cleanup-receipts', 'collabflow-cleanup-tokens',
    'collabflow-cleanup-inquiries', 'collabflow-cleanup-history') order by jobid loop
    perform cron.alter_job(job.jobid, active := false);
    paused_count := paused_count + 1;
  end loop;
  if paused_count = 0 then
    raise exception 'No matching CollabFlow cleanup jobs visible for current_user %; verify the scheduling administrator', current_user;
  end if;
  -- Includes already-paused jobs successfully confirmed inactive on a retry.
  raise notice 'Paused % CollabFlow cleanup jobs for % (including already-paused jobs); commit must succeed', paused_count, current_user;
end $$;
commit;
