begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Freeze the policy boundary while inserts are blocked. No existing inquiry
-- is updated, backfilled, or enrolled in automated retention.
lock table collabflow_private.collaboration_inquiries in share row exclusive mode;
alter table collabflow_private.inquiry_settings
  add column retention_effective_at timestamptz not null default clock_timestamp();
do $$ begin
  if not exists (select 1 from collabflow_private.inquiry_settings where singleton) then
    raise exception 'Inquiry settings singleton is missing';
  end if;
  if exists (select 1 from collabflow_private.collaboration_inquiries
    where created_at >= (select retention_effective_at from collabflow_private.inquiry_settings where singleton)) then
    raise exception 'Future-dated existing inquiries require explicit retention review';
  end if;
end $$;
update collabflow_private.inquiry_settings set retention_days = 180 where singleton;
comment on column collabflow_private.inquiry_settings.retention_effective_at is
  'Immutable automatic-retention cohort boundary. Earlier inquiries require a separate reviewed decision; never move this backward as routine maintenance.';
comment on column collabflow_private.collaboration_inquiries.retention_due_at is
  'New inquiries are due after 180 days. Only the post-policy cohort is eligible for scheduled cleanup. NULL and earlier inquiries are preserved. Account deletion still cascades.';
create index collaboration_inquiries_retention_due
  on collabflow_private.collaboration_inquiries (retention_due_at)
  where retention_due_at is not null;

create role collabflow_cleanup_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role collabflow_maintenance nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant usage on schema collabflow_private to collabflow_cleanup_executor, collabflow_maintenance;
grant select (singleton, retention_effective_at) on collabflow_private.inquiry_settings to collabflow_cleanup_executor;
create policy cleanup_settings_read on collabflow_private.inquiry_settings
  for select to collabflow_cleanup_executor using (true);

-- The definer owns no tables, cannot insert, and cannot read inquiry content.
-- PostgreSQL requires UPDATE privilege for row locking. WITH CHECK(false)
-- prevents actual updates; DELETE policies independently enforce expiration.
do $$ declare tab text; keys text; expiry text; eligibility text; begin
  foreach tab in array array['collaboration_inquiries', 'inquiry_attempts', 'inquiry_rates', 'inquiry_receipts', 'inquiry_tokens'] loop
    keys := case tab when 'collaboration_inquiries' then 'id, created_at'
      when 'inquiry_attempts' then 'ticket' when 'inquiry_rates' then 'scope, subject, bucket'
      when 'inquiry_receipts' then 'creator_id, submission_id' else 'token_hash' end;
    expiry := case when tab = 'collaboration_inquiries' then 'retention_due_at' else 'expires_at' end;
    eligibility := format('%I <= statement_timestamp()', expiry);
    if tab = 'collaboration_inquiries' then
      eligibility := eligibility || ' and created_at >= (select retention_effective_at from collabflow_private.inquiry_settings where singleton) and created_at <= statement_timestamp() - interval ''180 days''';
    end if;
    execute format('grant select (%s, %I), update (%I) on collabflow_private.%I to collabflow_cleanup_executor', keys, expiry, expiry, tab);
    execute format('grant delete on collabflow_private.%I to collabflow_cleanup_executor', tab);
    execute format('create policy cleanup_read on collabflow_private.%I for select to collabflow_cleanup_executor using (%s)', tab, eligibility);
    execute format('create policy cleanup_lock on collabflow_private.%I for update to collabflow_cleanup_executor using (%s) with check (false)', tab, eligibility);
    execute format('create policy cleanup_delete on collabflow_private.%I for delete to collabflow_cleanup_executor using (%s)', tab, eligibility);
  end loop;
end $$;

-- One call = one table, one batch, one transaction supplied by the caller.
-- Never accept an arbitrary SQL identifier, timestamp, or caller-supplied cutoff.
create function collabflow_private.cleanup_inquiry_data(p_table text, p_batch integer default 1000)
returns integer language plpgsql security definer set search_path = '' as $$
declare keys text; join_keys text; expiry text; cohort text := ''; deleted integer;
begin
  if p_batch is null or p_batch < 1 or p_batch > 2000 then
    raise exception 'Cleanup batch must be between 1 and 2000' using errcode = '22023';
  end if;
  case p_table
    when 'collaboration_inquiries' then
      keys := 'id'; join_keys := 'd.id = b.id'; expiry := 'retention_due_at';
      cohort := ' and created_at >= (select retention_effective_at from collabflow_private.inquiry_settings where singleton) and created_at <= statement_timestamp() - interval ''180 days''';
    when 'inquiry_attempts' then keys := 'ticket'; join_keys := 'd.ticket = b.ticket'; expiry := 'expires_at';
    when 'inquiry_rates' then keys := 'scope, subject, bucket'; join_keys := 'd.scope = b.scope and d.subject = b.subject and d.bucket = b.bucket'; expiry := 'expires_at';
    when 'inquiry_receipts' then keys := 'creator_id, submission_id'; join_keys := 'd.creator_id = b.creator_id and d.submission_id = b.submission_id'; expiry := 'expires_at';
    when 'inquiry_tokens' then keys := 'token_hash'; join_keys := 'd.token_hash = b.token_hash'; expiry := 'expires_at';
    else raise exception 'Unsupported cleanup table' using errcode = '22023';
  end case;
  execute format('with batch as materialized (
    select %s from collabflow_private.%I
    where %I <= statement_timestamp() %s order by %I
    limit $1 for update skip locked
  ) delete from collabflow_private.%I d using batch b where %s',
    keys, p_table, expiry, cohort, expiry, p_table, join_keys) using p_batch;
  get diagnostics deleted = row_count;
  return deleted;
end $$;
revoke all on function collabflow_private.cleanup_inquiry_data(text, integer)
  from public, anon, authenticated, service_role, collabflow_inquiry_writer, collabflow_inquiry_executor;
grant execute on function collabflow_private.cleanup_inquiry_data(text, integer) to collabflow_maintenance;

-- Transfer only function ownership; the administrative caller can SET ROLE to
-- the execute-only scheduler role. No application role receives membership.
do $$ begin
  execute format('grant collabflow_cleanup_executor, collabflow_maintenance to %I', current_user);
end $$;
grant create on schema collabflow_private to collabflow_cleanup_executor;
alter function collabflow_private.cleanup_inquiry_data(text, integer) owner to collabflow_cleanup_executor;
revoke create on schema collabflow_private from collabflow_cleanup_executor;
do $$ begin
  execute format('revoke collabflow_cleanup_executor from %I', current_user);
end $$;

-- No extension, schedule, API endpoint, or destructive maintenance call here.
commit;
