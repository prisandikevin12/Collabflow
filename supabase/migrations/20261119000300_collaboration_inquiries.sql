begin;

-- No password is provisioned here. Configure the LOGIN credential separately.
create role collabflow_inquiry_writer login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role collabflow_inquiry_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role collabflow_inquiry_writer set statement_timeout = '5s';
alter role collabflow_inquiry_writer set lock_timeout = '2s';
alter role collabflow_inquiry_writer set idle_in_transaction_session_timeout = '5s';
grant usage on schema collabflow_private to collabflow_inquiry_writer, collabflow_inquiry_executor;
-- Database CONNECT normally comes from PUBLIC; this is intentionally explicit.
do $$ begin execute format('grant connect on database %I to collabflow_inquiry_writer', current_database()); end $$;

create table collabflow_private.inquiry_settings (
  singleton boolean primary key default true check (singleton),
  retention_days integer check (retention_days between 1 and 3650)
);
-- NULL retains contents indefinitely pending an approved retention policy.
insert into collabflow_private.inquiry_settings (retention_days) values (null);

create table collabflow_private.collaboration_inquiries (
  id uuid primary key default gen_random_uuid(),
  creator_public_id uuid not null references public.creator_profiles(public_id) on delete cascade,
  sender_name text not null check (char_length(sender_name) between 1 and 100 and sender_name = btrim(sender_name) and sender_name !~ '[[:cntrl:]]'),
  sender_email text not null check (octet_length(sender_email) between 3 and 254 and sender_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and sender_email !~ '[[:cntrl:]]'),
  company text check (char_length(company) between 1 and 120 and company = btrim(company) and company !~ '[[:cntrl:]]'),
  message text not null check (char_length(message) between 10 and 5000 and octet_length(message) <= 20000 and message = btrim(message) and translate(message, E'\n\t', '') !~ '[[:cntrl:]]'),
  created_at timestamptz not null default clock_timestamp(),
  retention_due_at timestamptz
);
create index collaboration_inquiries_creator_created on collabflow_private.collaboration_inquiries (creator_public_id, created_at desc);
comment on column collabflow_private.collaboration_inquiries.retention_due_at is 'Advisory only. No automatic deletion is enabled. Account deletion still cascades.';

create table collabflow_private.inquiry_rates (
  scope text not null,
  subject text not null,
  bucket bigint not null,
  hits integer not null,
  expires_at timestamptz not null,
  primary key (scope, subject, bucket)
);
create table collabflow_private.inquiry_attempts (
  ticket uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  email_hash text not null,
  creator_id uuid not null,
  submission_id uuid not null,
  fingerprint text not null,
  expires_at timestamptz not null default (clock_timestamp() + interval '2 minutes'),
  used boolean not null default false
);
create table collabflow_private.inquiry_receipts (
  creator_id uuid not null,
  submission_id uuid not null,
  fingerprint text not null,
  receipt uuid not null,
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  primary key (creator_id, submission_id)
);
create table collabflow_private.inquiry_tokens (
  token_hash text primary key,
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours')
);

-- Support bounded administrator maintenance without full scans. No scheduler
-- or automatic deletion is enabled by this migration.
create index inquiry_rates_expiry on collabflow_private.inquiry_rates (expires_at);
create index inquiry_attempts_expiry on collabflow_private.inquiry_attempts (expires_at);
create index inquiry_receipts_expiry on collabflow_private.inquiry_receipts (expires_at);
create index inquiry_tokens_expiry on collabflow_private.inquiry_tokens (expires_at);

-- All objects are administrator-owned. Neither execution role owns a table.
do $$ declare tab text; begin
  foreach tab in array array['inquiry_settings', 'collaboration_inquiries', 'inquiry_rates', 'inquiry_attempts', 'inquiry_receipts', 'inquiry_tokens'] loop
    execute format('alter table collabflow_private.%I enable row level security', tab);
    execute format('alter table collabflow_private.%I force row level security', tab);
    execute format('revoke all on collabflow_private.%I from public, anon, authenticated, service_role, collabflow_inquiry_writer', tab);
    execute format('create policy inquiry_executor on collabflow_private.%I for all to collabflow_inquiry_executor using (true) with check (true)', tab);
  end loop;
end $$;
grant select on collabflow_private.inquiry_settings to collabflow_inquiry_executor;
grant insert on collabflow_private.collaboration_inquiries to collabflow_inquiry_executor;
grant select, insert, update on collabflow_private.inquiry_rates, collabflow_private.inquiry_attempts to collabflow_inquiry_executor;
grant select, insert on collabflow_private.inquiry_receipts, collabflow_private.inquiry_tokens to collabflow_inquiry_executor;

-- Use the existing projector's publication-only permissions for the row lock.
-- No existing profile grants or policies change. Writer cannot call this helper.
create function collabflow_private.lock_inquiry_publication(p_id uuid, p_slug text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public_id from public.creator_public_profiles where public_id = p_id and slug = p_slug for share;
  return found;
end $$;

create function collabflow_private.inquiry_take_rate(p_scope text, p_subject text, p_seconds integer, p_limit integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer; b bigint; begin
  b := floor(extract(epoch from clock_timestamp()) / p_seconds)::bigint;
  insert into collabflow_private.inquiry_rates (scope, subject, bucket, hits, expires_at)
  values (p_scope, p_subject, b, 1, to_timestamp((b + 1) * p_seconds) + interval '1 day')
  on conflict (scope, subject, bucket) do update set hits = least(collabflow_private.inquiry_rates.hits + 1, 1000000)
  returning hits into n;
  return n <= p_limit;
end $$;

create function collabflow_private.begin_inquiry_attempt(p_ip text, p_email text, p_creator uuid, p_submission uuid, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r collabflow_private.inquiry_receipts%rowtype; ticket_id uuid; ok boolean; begin
  if p_ip is null or p_email is null or p_fingerprint is null or p_creator is null or p_submission is null
    or p_ip !~ '^[a-f0-9]{64}$' or p_email !~ '^[a-f0-9]{64}$' or p_fingerprint !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Global first bounds attacker-controlled key cardinality. Every retry counts.
  if not collabflow_private.inquiry_take_rate('attempt-global', 'all', 3600, 10000) then
    return jsonb_build_object('status', 'throttled');
  end if;
  ok := collabflow_private.inquiry_take_rate('attempt-ip-short', p_ip, 600, 20);
  ok := collabflow_private.inquiry_take_rate('attempt-ip-hour', p_ip, 3600, 100) and ok;
  if not ok then return jsonb_build_object('status', 'throttled'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_creator::text || p_submission::text, 0));
  select * into r from collabflow_private.inquiry_receipts where creator_id = p_creator and submission_id = p_submission;
  if found then
    -- Expired receipts are deliberately NOT reusable until manual metadata cleanup.
    if r.fingerprint <> p_fingerprint then return jsonb_build_object('status', 'conflict'); end if;
    return jsonb_build_object('status', 'accepted', 'receipt', r.receipt);
  end if;
  insert into collabflow_private.inquiry_attempts (ip_hash, email_hash, creator_id, submission_id, fingerprint)
  values (p_ip, p_email, p_creator, p_submission, p_fingerprint) returning ticket into ticket_id;
  return jsonb_build_object('status', 'ready', 'ticket', ticket_id);
end $$;

create function collabflow_private.finish_inquiry(p_ticket uuid, p_slug text, p_token_hash text, p_name text, p_email text, p_company text, p_message text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a collabflow_private.inquiry_attempts%rowtype; r collabflow_private.inquiry_receipts%rowtype;
  receipt_id uuid := gen_random_uuid(); days integer; ok boolean; begin
  select * into a from collabflow_private.inquiry_attempts where ticket = p_ticket for update;
  if not found or a.used or a.expires_at <= clock_timestamp() then return jsonb_build_object('status', 'expired'); end if;
  update collabflow_private.inquiry_attempts set used = true where ticket = p_ticket;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status', 'invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(a.creator_id::text || a.submission_id::text, 0));
  select * into r from collabflow_private.inquiry_receipts where creator_id = a.creator_id and submission_id = a.submission_id;
  if found then
    if r.fingerprint <> a.fingerprint then return jsonb_build_object('status', 'conflict'); end if;
    return jsonb_build_object('status', 'accepted', 'receipt', r.receipt);
  end if;
  if not collabflow_private.lock_inquiry_publication(a.creator_id, p_slug) then return jsonb_build_object('status', 'not-found'); end if;
  -- All writers take quota locks in this order. Counts are conservative on denial.
  ok := collabflow_private.inquiry_take_rate('accepted-global', 'all', 86400, 1000);
  ok := collabflow_private.inquiry_take_rate('accepted-creator', a.creator_id::text, 86400, 100) and ok;
  ok := collabflow_private.inquiry_take_rate('accepted-ip', a.ip_hash, 3600, 5) and ok;
  ok := collabflow_private.inquiry_take_rate('accepted-email-creator', a.email_hash || a.creator_id::text, 86400, 3) and ok;
  if not ok then return jsonb_build_object('status', 'throttled'); end if;
  insert into collabflow_private.inquiry_tokens (token_hash) values (p_token_hash) on conflict do nothing;
  if not found then return jsonb_build_object('status', 'replay'); end if;
  select retention_days into days from collabflow_private.inquiry_settings where singleton;
  insert into collabflow_private.collaboration_inquiries (creator_public_id, sender_name, sender_email, company, message, retention_due_at)
  values (a.creator_id, p_name, p_email, nullif(p_company, ''), p_message,
    case when days is null then null else clock_timestamp() + make_interval(days => days) end);
  insert into collabflow_private.inquiry_receipts (creator_id, submission_id, fingerprint, receipt)
  values (a.creator_id, a.submission_id, a.fingerprint, receipt_id);
  return jsonb_build_object('status', 'accepted', 'receipt', receipt_id);
end $$;

-- Explicitly revoke default PUBLIC execute, including internal helpers.
revoke all on function collabflow_private.lock_inquiry_publication(uuid, text),
  collabflow_private.inquiry_take_rate(text, text, integer, integer),
  collabflow_private.begin_inquiry_attempt(text, text, uuid, uuid, text),
  collabflow_private.finish_inquiry(uuid, text, text, text, text, text, text)
  from public, anon, authenticated, service_role, collabflow_inquiry_writer;
grant execute on function collabflow_private.lock_inquiry_publication(uuid, text) to collabflow_inquiry_executor;
grant execute on function collabflow_private.begin_inquiry_attempt(text, text, uuid, uuid, text),
  collabflow_private.finish_inquiry(uuid, text, text, text, text, text, text) to collabflow_inquiry_writer;

do $$ begin
  execute format('grant collabflow_inquiry_executor, collabflow_profile_projector to %I', current_user);
end $$;
grant create on schema collabflow_private to collabflow_inquiry_executor, collabflow_profile_projector;
alter function collabflow_private.lock_inquiry_publication(uuid, text) owner to collabflow_profile_projector;
alter function collabflow_private.inquiry_take_rate(text, text, integer, integer) owner to collabflow_inquiry_executor;
alter function collabflow_private.begin_inquiry_attempt(text, text, uuid, uuid, text) owner to collabflow_inquiry_executor;
alter function collabflow_private.finish_inquiry(uuid, text, text, text, text, text, text) owner to collabflow_inquiry_executor;
revoke create on schema collabflow_private from collabflow_inquiry_executor, collabflow_profile_projector;
do $$ begin
  execute format('revoke collabflow_inquiry_executor, collabflow_profile_projector from %I', current_user);
end $$;
commit;
