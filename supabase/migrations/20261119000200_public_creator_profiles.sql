begin;

-- Existing profiles stay private. Neither identity nor publication can be
-- supplied through M1's column-scoped INSERT grant.
alter table public.creator_profiles
  add column public_id uuid not null default gen_random_uuid(),
  add column is_public boolean not null default false,
  add constraint creator_profiles_public_id_key unique (public_id),
  add constraint creator_profiles_public_identity_check check (public_id <> user_id);

grant update (is_public) on public.creator_profiles to authenticated;
-- M1's owner-only policies and existing column grants are otherwise unchanged.

create table public.creator_public_profiles (
  public_id uuid primary key references public.creator_profiles(public_id) on delete cascade,
  slug text not null unique,
  display_name text not null,
  bio text
);

alter table public.creator_public_profiles enable row level security;
alter table public.creator_public_profiles force row level security;
revoke all on public.creator_public_profiles from public, anon, authenticated, service_role;
-- Explicit columns prevent a future private column from becoming public by accident.
grant select (public_id, slug, display_name, bio)
  on public.creator_public_profiles to anon, authenticated;
create policy creator_public_profiles_read on public.creator_public_profiles
  for select to anon, authenticated using (true);

-- The trigger reads NEW only; this role gets no access to creator_profiles or
-- auth.users, owns no table, and cannot bypass RLS or log in.
create role collabflow_profile_projector nologin noinherit nobypassrls;
create schema collabflow_private;
revoke all on schema collabflow_private from public, anon, authenticated, service_role;
grant usage on schema public, collabflow_private to collabflow_profile_projector;
grant select, insert, update, delete on public.creator_public_profiles to collabflow_profile_projector;
create policy creator_public_profiles_projector on public.creator_public_profiles
  for all to collabflow_profile_projector using (true) with check (true);

create function collabflow_private.sync_creator_public_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_public then
    insert into public.creator_public_profiles (public_id, slug, display_name, bio)
    values (new.public_id, new.slug, new.display_name, new.bio)
    on conflict (public_id) do update set
      slug = excluded.slug,
      display_name = excluded.display_name,
      bio = excluded.bio;
  else
    delete from public.creator_public_profiles where public_id = new.public_id;
  end if;
  return new;
end;
$$;

revoke all on function collabflow_private.sync_creator_public_profile()
  from public, anon, authenticated, service_role;

-- Temporary ownership-transfer privileges for the migration administrator only.
do $$ begin
  execute format('grant collabflow_profile_projector to %I', current_user);
end $$;
grant create on schema collabflow_private to collabflow_profile_projector;
alter function collabflow_private.sync_creator_public_profile() owner to collabflow_profile_projector;
revoke create on schema collabflow_private from collabflow_profile_projector;

create trigger creator_profiles_public_projection
after insert or update of display_name, slug, bio, is_public on public.creator_profiles
for each row execute function collabflow_private.sync_creator_public_profile();

do $$ begin
  execute format('revoke collabflow_profile_projector from %I', current_user);
end $$;

commit;
