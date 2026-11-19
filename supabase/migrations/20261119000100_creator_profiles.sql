begin;

create table public.creator_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  slug text not null,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_profiles_slug_key unique (slug),
  constraint creator_profiles_display_name_check check (
    char_length(display_name) between 2 and 60
    and display_name = btrim(display_name)
    and display_name !~ '[[:cntrl:]]'
    and display_name ~ '[^[:space:]]'
  ),
  constraint creator_profiles_slug_format_check check (
    char_length(slug) between 3 and 40
    and slug collate "C" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint creator_profiles_slug_reserved_check check (
    slug not in (
      'admin', 'api', 'app', 'auth', 'billing', 'collabflow', 'dashboard',
      'help', 'login', 'logout', 'onboarding', 'privacy', 'protected',
      'settings', 'signup', 'support', 'terms', 'www'
    )
  ),
  constraint creator_profiles_bio_checkq check (
    bio is null or (
      char_length(bio) <= 280 and bio = btrim(bio)
      and bio !~ '[[:cntrl:]]'
    )
  )
);

alter table public.creator_profiles enable row level security;
alter table public.creator_profiles force row level security;

-- Supabase may supply default table grants. Remove them before granting
-- only the operations and writable columns used by this milestone.
revoke all on table public.creator_profiles from public, anon, authenticated;
grant select on table public.creator_profiles to authenticated;
grant insert (user_id, display_name, slug, bio) on public.creator_profiles to authenticated;
grant update (display_name, slug, bio) on public.creator_profiles to authenticated;

create policy creator_profiles_select_own on public.creator_profiles
  for select to authenticated using ((select auth.uid()) = user_id);
create policy creator_profiles_insert_own on public.creator_profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy creator_profiles_update_own on public.creator_profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create function public.creator_profiles_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.creator_profiles_set_updated_at() from public, anon, authenticated;

create trigger creator_profiles_updated_at
before update on public.creator_profiles
for each row execute function public.creator_profiles_set_updated_at();

commit;
