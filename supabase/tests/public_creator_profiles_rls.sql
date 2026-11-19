-- Portable SQL, run by the embedded PostgreSQL test and by a database admin
-- in an approved staging environment. Set test.user_a/test.user_b to two
-- distinct existing Auth UUIDs without creator profiles before running.
-- Everything below rolls back. Never use an RLS-bypassing role for assertions.
begin;
do $$ begin
  if current_setting('test.user_a')::uuid = current_setting('test.user_b')::uuid then
    raise exception 'Two distinct users required';
  end if;
  if (select count(*) from auth.users where id in (current_setting('test.user_a')::uuid, current_setting('test.user_b')::uuid)) <> 2 then
    raise exception 'Create two Auth test users first';
  end if;
  if exists (select 1 from public.creator_profiles where user_id in (current_setting('test.user_a')::uuid, current_setting('test.user_b')::uuid)) then
    raise exception 'Use test users without profiles';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_b'), 'role', 'authenticated')::text, true);
insert into public.creator_profiles (user_id, display_name, slug)
values (auth.uid(), 'Creator B', 'rls-b-' || left(auth.uid()::text, 8));
select set_config('test.public_b', public_id::text, true) from public.creator_profiles where user_id = auth.uid();
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);
insert into public.creator_profiles (user_id, display_name, slug, bio)
values (auth.uid(), 'Creator A', 'rls-a-' || left(auth.uid()::text, 8), 'Original bio');
select set_config('test.public_a', public_id::text, true) from public.creator_profiles where user_id = auth.uid();

do $$ declare affected integer; begin
  if (select is_public from public.creator_profiles where user_id = auth.uid()) then raise exception 'New profile was published by default'; end if;
  if current_setting('test.public_a') = current_setting('test.user_a') then raise exception 'Public identity exposes Auth UUID'; end if;
  update public.creator_profiles set is_public = true where user_id = current_setting('test.user_b')::uuid;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A can publish B'; end if;
  begin
    update public.creator_profiles set public_id = gen_random_uuid() where user_id = auth.uid();
    raise exception 'Public identity can be changed';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role anon;
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  if exists (select 1 from public.creator_public_profiles where public_id in (current_setting('test.public_a')::uuid, current_setting('test.public_b')::uuid)) then raise exception 'Unpublished profile leaked'; end if;
  begin
    perform * from public.creator_profiles;
    raise exception 'Anonymous private read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    update public.creator_profiles set is_public = true;
    raise exception 'Anonymous publication was allowed';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);
update public.creator_profiles set is_public = true where user_id = auth.uid();
do $$ begin
  if (select display_name from public.creator_public_profiles where public_id = current_setting('test.public_a')::uuid) is distinct from 'Creator A' then raise exception 'Publish did not synchronize'; end if;
  if exists (select 1 from public.creator_profiles where user_id = current_setting('test.user_b')::uuid) then raise exception 'Private owner RLS changed'; end if;
  begin
    update public.creator_public_profiles set bio = 'Tampered';
    raise exception 'Authenticated direct projection write allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform collabflow_private.sync_creator_public_profile();
    raise exception 'Client can execute projection function';
  exception when insufficient_privilege then null; end;
end $$;
update public.creator_profiles set display_name = 'Updated A', bio = 'Updated bio', slug = 'rls-new-' || left(auth.uid()::text, 8) where user_id = auth.uid();

reset role;
set local role anon;
select set_config('request.jwt.claims', '{}', true);
do $$ declare item record; begin
  select public_id, slug, display_name, bio into item from public.creator_public_profiles where public_id = current_setting('test.public_a')::uuid;
  if item.display_name is distinct from 'Updated A' or item.bio is distinct from 'Updated bio' or item.slug is distinct from 'rls-new-' || left(current_setting('test.user_a'), 8) then raise exception 'Published edit is stale'; end if;
  if exists (select 1 from public.creator_public_profiles where slug = 'rls-a-' || left(current_setting('test.user_a'), 8)) then raise exception 'Old slug remains public'; end if;
  begin
    insert into public.creator_public_profiles (public_id, slug, display_name) values (gen_random_uuid(), 'forged-public', 'Forged');
    raise exception 'Anonymous projection insert allowed';
  exception when insufficient_privilege then null; end;
  begin
    update public.creator_public_profiles set display_name = 'Forged';
    raise exception 'Anonymous projection update allowed';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.creator_public_profiles;
    raise exception 'Anonymous projection delete allowed';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_b'), 'role', 'authenticated')::text, true);
do $$ declare affected integer; begin
  update public.creator_profiles set is_public = false where user_id = current_setting('test.user_a')::uuid;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'B can unpublish A'; end if;
  if not exists (select 1 from public.creator_public_profiles where public_id = current_setting('test.public_a')::uuid) then raise exception 'Cross-owner attempt removed A'; end if;
end $$;
update public.creator_profiles set is_public = true where user_id = auth.uid();
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);
do $$ begin
  begin
    update public.creator_profiles set slug = 'rls-b-' || left(current_setting('test.user_b'), 8) where user_id = auth.uid();
    raise exception 'Duplicate slug accepted';
  exception when unique_violation then null; end;
  if not exists (select 1 from public.creator_public_profiles where public_id = current_setting('test.public_a')::uuid and slug = 'rls-new-' || left(current_setting('test.user_a'), 8)) then raise exception 'Failed edit damaged projection'; end if;
end $$;
update public.creator_profiles set is_public = false where user_id = auth.uid();
update public.creator_profiles set bio = 'Private edit' where user_id = auth.uid();

reset role;
set local role anon;
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  if exists (select 1 from public.creator_public_profiles where public_id = current_setting('test.public_a')::uuid) then raise exception 'Unpublished profile still visible'; end if;
  if not exists (select 1 from public.creator_public_profiles where public_id = current_setting('test.public_b')::uuid) then raise exception 'Unpublishing A affected B'; end if;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);
update public.creator_profiles set is_public = true where user_id = auth.uid();
do $$ begin
  if (select bio from public.creator_public_profiles where public_id = current_setting('test.public_a')::uuid) is distinct from 'Private edit' then raise exception 'Republish used stale values'; end if;
end $$;

reset role;
delete from auth.users where id = current_setting('test.user_a')::uuid;
set local role anon;
do $$ begin
  if exists (select 1 from public.creator_public_profiles where public_id = current_setting('test.public_a')::uuid) then raise exception 'Deleted account left public data'; end if;
end $$;
reset role;
rollback;
