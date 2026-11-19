-- Run with psql against an approved LOCAL / disposable database after applying
-- the migration. Supply two distinct, existing Auth user UUIDs with no profiles:
-- psql "$LOCAL_DATABASE_URL" -v user_a=UUID_A -v user_b=UUID_B -f supabase/tests/creator_profiles_rls.sql
-- This script uses database role impersonation, never a service-role API key.
\set ON_ERROR_STOP on
begin;
select set_config('test.user_a', :'user_a', true);
select set_config('test.user_b', :'user_b', true);

do $$
begin
  if current_setting('test.user_a')::uuid = current_setting('test.user_b')::uuid then
    raise exception 'Two distinct test users are required';
  end if;
  if (select count(*) from auth.users where id in (
    current_setting('test.user_a')::uuid, current_setting('test.user_b')::uuid
  )) <> 2 then raise exception 'Create both test users through Auth first'; end if;
  if exists (select 1 from public.creator_profiles where user_id in (
    current_setting('test.user_a')::uuid, current_setting('test.user_b')::uuid
  )) then raise exception 'Use test users without existing profiles'; end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);
insert into public.creator_profiles (user_id, display_name, slug, bio)
values (auth.uid(), 'Creator A', 'rls-' || replace(auth.uid()::text, '-', ''), 'Private A');

do $$
declare affected integer;
begin
  if (select count(*) from public.creator_profiles) <> 1 then
    raise exception 'A must see only their own row';
  end if;
  begin
    insert into public.creator_profiles (user_id, display_name, slug)
    values (current_setting('test.user_b')::uuid, 'Forged B', 'forged-owner');
    raise exception 'Forged ownership was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.creator_profiles (user_id, display_name, slug)
    values (auth.uid(), 'Duplicate A', 'another-slug');
    raise exception 'Duplicate profile was accepted';
  exception when unique_violation then null;
  end;
  begin
    update public.creator_profiles set user_id = current_setting('test.user_b')::uuid where user_id = auth.uid();
    raise exception 'Owner mutation was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.creator_profiles set created_at = now() where user_id = auth.uid();
    raise exception 'Timestamp mutation was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.creator_profiles where user_id = auth.uid();
    raise exception 'Delete was accepted';
  exception when insufficient_privilege then null;
  end;
  update public.creator_profiles set display_name = 'Updated A' where user_id = auth.uid();
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Own update failed'; end if;
end;
$$;

-- B cannot see A's profile, but uniqueness must still protect A's slug.
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_b'), 'role', 'authenticated')::text, true);
do $$
declare affected integer; invalid_slug text;
begin
  if exists (select 1 from public.creator_profiles) then raise exception 'B can read A'; end if;
  update public.creator_profiles set bio = 'Tampered' where user_id = current_setting('test.user_a')::uuid;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'B can update A'; end if;
  begin
    insert into public.creator_profiles (user_id, display_name, slug)
    values (auth.uid(), 'Creator B', 'rls-' || replace(current_setting('test.user_a'), '-', ''));
    raise exception 'Duplicate slug was accepted';
  exception when unique_violation then null;
  end;
  foreach invalid_slug in array array['admin', 'UPPERCASE', 'ab', '-bad', 'bad--slug', 'bad_slug', repeat('x', 41)] loop
    begin
      insert into public.creator_profiles (user_id, display_name, slug)
      values (auth.uid(), 'Creator B', invalid_slug);
      raise exception 'Invalid slug was accepted: %', invalid_slug;
    exception when check_violation then null;
    end;
  end loop;
end;
$$;
insert into public.creator_profiles (user_id, display_name, slug)
values (auth.uid(), 'Creator B', 'rls-' || replace(auth.uid()::text, '-', ''));
do $$
begin
  if (select count(*) from public.creator_profiles) <> 1 then raise exception 'B must see only B'; end if;
end;
$$;

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);
do $$
declare affected integer;
begin
  if exists (select 1 from public.creator_profiles where user_id = current_setting('test.user_b')::uuid) then raise exception 'A can read B'; end if;
  update public.creator_profiles set bio = 'Tampered' where user_id = current_setting('test.user_b')::uuid;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A can update B'; end if;
  if (select display_name from public.creator_profiles where user_id = auth.uid()) <> 'Updated A' then raise exception 'A was modified unexpectedly'; end if;
end;
$$;

reset role;
set local role anon;
select set_config('request.jwt.claims', '{}', true);
do $$
begin
  begin
    perform * from public.creator_profiles;
    raise exception 'Anonymous read was allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.creator_profiles (user_id, display_name, slug)
    values (current_setting('test.user_a')::uuid, 'Anonymous', 'anonymous-slug');
    raise exception 'Anonymous insert was allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.creator_profiles set bio = 'Anonymous';
    raise exception 'Anonymous update was allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
rollback;
\echo 'Creator profile RLS checks passed; all test writes rolled back.'
