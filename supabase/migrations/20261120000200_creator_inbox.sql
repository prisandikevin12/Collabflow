begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Keep collabflow_private OUT of PostgREST's exposed schemas. Only these two
-- public-schema RPCs are the Data API entry points; neither elevates privileges.
grant usage on schema collabflow_private to authenticated;
grant select (id, creator_public_id, sender_name, sender_email, company, message, created_at)
  on collabflow_private.collaboration_inquiries to authenticated;
create policy inquiries_read_own on collabflow_private.collaboration_inquiries
  for select to authenticated using (
    creator_public_id in (
      select p.public_id from public.creator_profiles p
      where p.user_id = (select auth.uid())
    )
  );

-- Preserve ENABLE/FORCE RLS and all existing writer/cleanup permissions.
-- This supports stable keyset pagination even when timestamps tie.
create index collaboration_inquiries_owner_cursor
  on collabflow_private.collaboration_inquiries (creator_public_id, created_at desc, id desc);

create function public.list_creator_inquiries(
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 21
) returns table (id uuid, sender_name text, company text, created_at timestamptz, message_preview text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 21
    or (p_before_created_at is null) <> (p_before_id is null)
    or (p_before_created_at is not null and not isfinite(p_before_created_at)) then
    raise exception 'Invalid inbox pagination' using errcode = '22023';
  end if;
  return query
    select i.id, i.sender_name, i.company, i.created_at, left(i.message, 240)
    from collabflow_private.collaboration_inquiries i
    where i.creator_public_id in (
      select p.public_id from public.creator_profiles p where p.user_id = (select auth.uid())
    ) and (p_before_created_at is null or (i.created_at, i.id) < (p_before_created_at, p_before_id))
    order by i.created_at desc, i.id desc limit p_limit;
end $$;

create function public.get_creator_inquiry(p_inquiry_id uuid)
returns table (id uuid, sender_name text, sender_email text, company text, message text, created_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return query
    select i.id, i.sender_name, i.sender_email, i.company, i.message, i.created_at
    from collabflow_private.collaboration_inquiries i
    where i.id = p_inquiry_id and i.creator_public_id in (
      select p.public_id from public.creator_profiles p where p.user_id = (select auth.uid())
    ) limit 1;
end $$;

-- Supabase default function grants can include application roles. Be explicit.
revoke all on function public.list_creator_inquiries(timestamptz, uuid, integer),
  public.get_creator_inquiry(uuid)
  from public, anon, authenticated, service_role, collabflow_inquiry_writer, collabflow_inquiry_executor;
grant execute on function public.list_creator_inquiries(timestamptz, uuid, integer),
  public.get_creator_inquiry(uuid) to authenticated;

comment on function public.list_creator_inquiries(timestamptz, uuid, integer) is
  'Read-only owner inbox, at most 21 previews. Caller identity comes exclusively from auth.uid().';
comment on function public.get_creator_inquiry(uuid) is
  'Read-only owner detail. Missing and foreign-owned IDs both return zero rows.';
commit;
