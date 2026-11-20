-- Read-only; safe before the NEW migration. Contains no inquiry content,
-- connection credentials, or destructive SQL. Run as the database admin.
begin transaction read only;
select count(*) as total_inquiries,
  count(*) filter (where retention_due_at is null) as without_retention_due_at,
  count(*) filter (where retention_due_at <= statement_timestamp()) as past_retention_deadline,
  min(created_at) as oldest_inquiry,
  max(created_at) as newest_inquiry
from collabflow_private.collaboration_inquiries;

select retention_days from collabflow_private.inquiry_settings where singleton;
-- to_jsonb works before and after the new column exists.
select to_jsonb(s)->>'retention_effective_at' as retention_effective_at
from collabflow_private.inquiry_settings s where singleton;
select count(*) filter (where i.created_at < (to_jsonb(s)->>'retention_effective_at')::timestamptz) as protected_legacy_inquiries,
  count(*) filter (where i.created_at >= (to_jsonb(s)->>'retention_effective_at')::timestamptz
    and i.created_at <= statement_timestamp()-interval '180 days'
    and i.retention_due_at <= statement_timestamp()) as eligible_expired_inquiries
from collabflow_private.collaboration_inquiries i
cross join collabflow_private.inquiry_settings s where s.singleton;

select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='collabflow_private' and c.relkind='r' order by c.relname;
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname='collabflow_private' order by tablename, policyname;
select indexname, indexdef from pg_indexes where schemaname='collabflow_private' order by indexname;

-- Every returned allowed value must be false for the application roles.
select r as role_name, t as table_name,
  has_table_privilege(r, 'collabflow_private.' || t, 'delete,truncate') as allowed
from unnest(array['anon','authenticated','service_role','collabflow_inquiry_writer','collabflow_inquiry_executor']) r
cross join unnest(array['inquiry_settings','collaboration_inquiries','inquiry_attempts','inquiry_rates','inquiry_receipts','inquiry_tokens']) t;
select p.oid::regprocedure as function, pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer, p.proconfig, p.proacl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='collabflow_private' order by p.proname;
select r as role_name, p.proname, has_function_privilege(r, p.oid, 'execute') as allowed
from unnest(array['anon','authenticated','service_role','collabflow_inquiry_writer','collabflow_inquiry_executor']) r
cross join pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='collabflow_private' and p.proname='cleanup_inquiry_data';
select rolname, rolsuper, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
from pg_roles where rolname in ('collabflow_cleanup_executor','collabflow_maintenance');
select parent.rolname as granted_role, member.rolname as member_role, m.admin_option
from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member
where parent.rolname in ('collabflow_cleanup_executor','collabflow_maintenance')
  or member.rolname in ('collabflow_cleanup_executor','collabflow_maintenance');
select r.rolname, has_schema_privilege(r.oid, 'collabflow_private', 'create') as can_create
from pg_roles r where r.rolname in ('collabflow_cleanup_executor','collabflow_maintenance');
select extname, extversion from pg_extension where extname='pg_cron';
commit;
