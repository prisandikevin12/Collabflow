# Milestone 2A.1: public creator profiles

Implementation and local verification were completed on 2026-11-19, continuing the existing uncommitted implementation on M1 commit `011c47a`. The code and database security review is now complete, and the implementation is conditionally approved. M1 has already been applied to Supabase, and M2A.1 has been applied successfully to the `collabflow-dev` Supabase project. M2A.1 application code has not been committed, pushed, or deployed.

The hosted verification below records the results supplied by the project owner on 2026-11-19; it was not rerun during this documentation-only update. The original local automation used disposable, in-memory PGlite PostgreSQL instances and a local HTTP database fixture. This documentation update changes no runtime code, migrations, or environment variables and performs no database operations, commit, push, or deployment.

## Implementation

- Profiles start private, including existing M1 profiles. The dashboard offers explicit publish/unpublish actions, shows current publication status, and links to `/c/{slug}` only when published. Onboarding explains the opt-in behavior.
- Publication verifies the current Auth user and changes only that user's `is_public` flag. Submitted owner/public identities and other fields are ignored. Invalid or repeated publication values are rejected. Failed and zero-row writes cannot report success.
- Public pages show display name, slug, and optional bio. They do not expose email, Auth UUID, ownership, timestamps, or private profile fields. Inquiry functionality remains out of scope.
- The database stores a separate public projection with exactly `public_id`, `slug`, `display_name`, and `bio`. `public_id` is a generated UUID distinct from the Auth UUID. The projection contains published profiles only.
- A transactionally synchronized trigger updates the projection on publish, edit, or slug change, deletes it on unpublish, and republishes current values. Foreign-key cascades remove it on account deletion. Existing M1 owner policies remain unchanged.
- Public reads use the publishable/anonymous key, without user sessions or cookie forwarding, and request only the four approved fields. Results are explicitly serialized to discard unexpected fields. No service-role client is introduced.
- Only the single-segment `/c/[slug]` route bypasses the normal session guard. Nested paths, including image-like paths, remain guarded. The auth redirect allowlist remains unchanged.

## HTTP fix completed in this continuation

The initial local production-build HTTP tests reproduced 307/200 responses for missing profiles and 200 responses for database failures. The existing approach rewrote to ordinary error pages: loopback hostname normalization could re-enter the login guard, and internal page rendering did not preserve the proxy's intended status.

[The public response boundary](../lib/creator/public-response.ts) now returns a complete, generic HTML response directly for 404 and 503 outcomes. [The error document](../lib/creator/public-status.ts) includes responsive layout, accessible navigation, a meaningful title, and no request or database values. It requires no JavaScript. The obsolete rewrite target pages were removed. Successful profiles continue through the existing React page, using the same public snapshot that passed the proxy check.

- Unknown, unpublished, and invalid slugs return actual HTTP 404, without redirecting to login.
- Database/configuration failures for valid slugs return HTTP 503 with no upstream details.
- Invalid-format slugs are rejected before creating a database client, so they do not require working database configuration.
- Public responses disable caching. Error responses include `X-Robots-Tag: noindex` and an HTML robots tag. HEAD error responses have no body.
- The proxy overwrites browser-supplied public-profile headers. Rendering accepts only the four public fields with the matching slug.

## Local automated verification

These are the recorded local results from 2026-11-19, preserved unchanged. Tests and builds were not rerun for this documentation-only update.

| Check | Result |
| --- | --- |
| `npm.cmd test` | PASS: 97 tests, 0 failures, 0 skipped |
| `npm.cmd run test:http` after the production build | PASS: 10 tests (9 cases plus enclosing test), 0 failures, 0 skipped |
| `npm.cmd run lint` | PASS, exit 0 |
| `npm.cmd run typecheck` | PASS, exit 0 |
| `npm.cmd run build` | PASS, exit 0; 17 static generation entries processed |
| Editor diagnostics | No errors found |
| `git diff --check` | PASS; Git prints existing Windows line-ending conversion notices |
| Original M1 SQL assertions | PASS before and after M2A.1 in embedded PostgreSQL |
| M2A.1 publication/RLS SQL assertions | PASS in embedded PostgreSQL |

The local production-build HTTP suite starts `next start` on an ephemeral loopback port and supplies a local public-database HTTP fixture. It stops both servers afterward. It verifies rendered public fields, filtering of unexpected private fields, actual 404/503 statuses, no-cache headers, HEAD, a missing-profile React navigation request, forged header rejection, Unicode limits, HTML escaping, slug changes, immediate unpublication, protected-route redirects, and public M1 auth entry pages. These are production Next.js HTTP tests with a fixture database, not Vercel production tests or live Supabase integration tests.

The full automated suite also covers existing M1 validation, normalization, reserved slugs, owner-derived writes, immutable fields, creation races, error masking, routing, confirmation/recovery redirect policies, and environment-file exclusions.

The editor build-task API returned `No invocation context`, so the production build ran through the existing npm script in the terminal. PowerShell requires `npm.cmd` because its `npm.ps1` wrapper is disabled. Non-failing existing warnings remain: Node infers ES module syntax for TypeScript test imports, and Next warns that `cacheComponents` has no explicit `partialPrefetching` choice. Neither configuration was changed merely to suppress a warning.

## Real Supabase database verification — completed

The project owner reported the following completed checks for the hosted `collabflow-dev` database. These results are separate from the local automated test counts above.

| Check | Reported result |
| --- | --- |
| M1 migration | Already applied to Supabase |
| M2A.1 migration | Applied successfully to `collabflow-dev` |
| Existing creator profiles | Remain private |
| `creator_profiles` and `creator_public_profiles` | RLS enabled and forced on both tables |
| Publication projector | No LOGIN or BYPASSRLS |
| Anonymous access | Read-only access to explicitly approved public profile columns |
| Database ownership isolation | Passed using two existing creator accounts |
| Transactional publish/unpublish | Passed |
| Test cleanup | Test transaction rolled back |

The supplied results establish these hosted database checks. They do not establish that the repository's complete SQL test scripts were run on Supabase, or that real Auth/PostgREST HTTP requests, application form interactions, or Vercel behavior were tested. In particular, the hosted ownership checks used existing creator accounts; the reusable SQL suites documented below require disposable users without existing profiles.

## Vercel production verification — pending

No M2A.1 application code has been committed, pushed, or deployed. The following require a separately approved deployment and remain pending:

- Public HTTP behavior through Vercel: published 200 responses, missing/unpublished/invalid 404 responses, and safe 503 responses for database failures.
- Browser publication/edit/unpublication flows with real Auth sessions, plus M1 onboarding, dashboard, login, confirmation, and recovery regressions.
- Cache headers and actual CDN behavior, including freshness after edits, slug changes, and unpublication.

The successful local build and local HTTP tests do not mark any of these Vercel checks as passed. Real Auth/PostgREST and authenticated browser integration checks are also not recorded as completed by the hosted database verification above.

## Migration security review

The code and database security review is complete. The review covered [the M2A.1 migration](../supabase/migrations/20261119000200_public_creator_profiles.sql), the M1 schema, and both SQL authorization suites. No migration changes were necessary during the implementation continuation or this documentation update. The table below describes code review and local embedded PostgreSQL evidence; the separately reported hosted results are listed above.

| Boundary | Implementation and evidence |
| --- | --- |
| Private profiles | Existing owner-only SELECT/INSERT/UPDATE policies are identical before and after M2A.1. Both tables enable and force RLS. Original M1 SQL assertions pass against both schemas. |
| Publication | `is_public` defaults false for old and new rows. Only an owner can update their flag. Clients cannot supply publication or public identity on INSERT. |
| Identity | `public_id` is unique, generated, unequal to `user_id`, and not client-writable. |
| Public reads | Only the four explicit public columns are granted to `anon`/`authenticated`. A test adds a hypothetical private column and confirms both roles cannot read it. Published projection rows are publicly enumerable by design. |
| Public writes | PUBLIC, anon, authenticated, and service-role table grants are revoked before explicit read grants. Direct client projection writes are denied. |
| Trigger privilege | The SECURITY DEFINER function has an empty `search_path`, schema-qualified table references, and a dedicated NOLOGIN/NOINHERIT/NOBYPASSRLS, non-superuser owner. That role owns no table and has no direct access to private profiles or Auth users. Its access is limited to projection synchronization. |
| Function exposure | The function resides in a private schema; client/service roles lack schema usage and function execution. The projector's temporary schema CREATE permission and migration-administrator membership are revoked. Tests confirm neither remains. |
| Consistency | Publish/edit/rename/unpublish/republish, duplicate-slug rollback, cross-owner denial, and account-deletion cleanup pass executable PostgreSQL assertions. |

The embedded tests use real PostgreSQL authorization behavior with a minimal Supabase Auth contract. They do not reproduce the hosted project's exact role memberships, default privileges, PostgREST schema exposure, or administrator capabilities. Successful hosted migration application and the reported database checks now supplement that evidence; unreported hosted properties and API behavior are not inferred from those results. Keep `collabflow_private` outside exposed API schemas; do not grant clients the projector role or weaken RLS to resolve an installation problem.

## Manual migration reference — other unapplied environments only

M1 and M2A.1 are already applied in `collabflow-dev`; do not reapply them there. Retain the instructions below for other environments where the relevant migrations are absent, with separate approval for that target. The completed hosted application and verification record is above. These commands were not run during this documentation update.

1. Review both migration files and establish an approved backup/recovery plan. Confirm the target project/database identity and migration history. Start with disposable/local Supabase or staging. This schema requires Supabase's `auth.users`, `auth.uid()`, `anon`, `authenticated`, and `service_role` contracts.
2. Use an authorized database administrator with table-alter/schema-creation privileges and permission to create the projector role, temporarily grant it to itself, and transfer function ownership. The embedded test runner uses its own administrator; it does not certify hosted administrator permissions.
3. Check that M1 is present exactly once and M2A.1 is absent. In an approved SQL session, inspect:

   ```sql
   select current_database(), current_user;
   select to_regclass('public.creator_profiles') as m1_table,
          to_regclass('public.creator_public_profiles') as m2_projection;
   select rolname, rolcanlogin, rolcreaterole, rolbypassrls, rolsuper
   from pg_roles
   where rolname in (current_user, 'collabflow_profile_projector');
   select nspname from pg_namespace where nspname = 'collabflow_private';
   select column_name from information_schema.columns
   where table_schema = 'public' and table_name = 'creator_profiles';
   ```

   Before M2A.1, its projection, role, schema, and new columns should not exist. If they do, stop and reconcile schema/history; the migration is intentionally not idempotent.
4. Only if M1 has never been applied, apply [M1](../supabase/migrations/20261119000100_creator_profiles.sql) first. Then apply only [M2A.1](../supabase/migrations/20261119000200_public_creator_profiles.sql). Example PowerShell commands for an explicitly approved disposable/local database whose connection is already securely configured:

   ```powershell
   # ONLY when M1 is absent:
   psql "$env:LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261119000100_creator_profiles.sql

   # Then apply M2A.1 once:
   psql "$env:LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261119000200_public_creator_profiles.sql
   ```

   Each file has its own transaction. If M2A.1 fails, M1 remains; stop and investigate without loosening security. For an approved hosted application, use the team's tracked migration procedure or record SQL-editor application and reconcile migration history. Do not run a blanket command that applies every pending migration. Keep connection secrets out of source control and shared output.
5. Immediately verify existing profiles are private, have distinct generated public identities, and the projection is empty before any publication. Inspect both tables' RLS flags, policies, column privileges, function owner/search path/ACL, and absence of projector membership. The transaction's ALTER TABLE and UUID backfill may hold locks; plan an appropriate window for the actual data volume.
6. Create two disposable Auth accounts with distinct UUIDs and no creator profiles. Run the original M1 rollback-only checks after both migrations:

   ```powershell
   psql "$env:LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -v user_a=USER_A_UUID -v user_b=USER_B_UUID -f supabase/tests/creator_profiles_rls.sql
   ```

   Then run [the publication RLS checks](../supabase/tests/public_creator_profiles_rls.sql) with the settings established in the same connection (replace the UUID placeholders):

   ```powershell
   psql "$env:LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 `
     -c "select set_config('test.user_a', 'USER_A_UUID', false), set_config('test.user_b', 'USER_B_UUID', false);" `
     -f supabase/tests/public_creator_profiles_rls.sql
   ```

   Both suites roll back their profile/test mutations. The publication suite also tests account deletion inside its rollback transaction. Use disposable users only. Role/JWT impersonation assertions execute as anon/authenticated, not an RLS-bypassing administrator.
7. Verify actual PostgREST access with the publishable key and two real user sessions. Expect anonymous private-table reads/writes to fail; owner-only private access; cross-owner publication updates to affect zero rows; public projection SELECT to expose only approved columns; direct projection writes to fail. Confirm PostgREST has refreshed its schema cache before testing the application.
8. Complete the browser checklist below. Apply the schema before releasing this application version: owner-profile reads now select `is_public`, so deploying the code against M1-only schema breaks authenticated workspace reads. No deployment is part of this task.
9. Prefer a forward fix or an application rollback if release verification fails. Do not drop the private profile table or blindly remove columns/roles. The M1 application can use the additive schema, but rolling back the UI alone does not unpublish projection rows; any publication rollback needs a separate explicit decision.

## Manual browser checks — pending

The database migration prerequisite is satisfied for `collabflow-dev`. These application/browser checks are not covered by the reported hosted database tests and remain pending against an approved running M2A.1 application. Vercel verification requires a separately approved deployment.

1. Sign up, confirm email, log in/out, and recover/reset a password. Confirm M1 dashboard/onboarding routing, legacy `/protected`, existing-profile onboarding protection, and safe expired-session behavior.
2. Create and edit a private profile. Confirm its link returns 404 in a signed-out window and the dashboard says private. Recheck M1 validation, duplicate slugs, retained input on failure, and immutable owner/timestamps.
3. Publish. Confirm dashboard feedback and live link; view signed out and as user B. Inspect HTML/network results for private fields. Empty bio, long Unicode names, mobile widths, keyboard navigation, and pending/error feedback should remain usable.
4. Rename/edit a published profile. Confirm the new URL/content works and the old URL returns 404. Unpublish and refresh the public URL; confirm 404 immediately. Republish and confirm current values. Already delivered browser content cannot be recalled by unpublishing.
5. Use B's session to attempt to publish/unpublish A and mutate public identities/projection rows. Check the expected permission denials/zero-row updates, then confirm A's content is unchanged.
6. In the disposable environment, simulate a database outage. Valid creator URLs should return 503 with the generic message; invalid-format slugs should remain 404. Restore the database and retry.

## Remaining limits

- Hosted migration application and the reported database security, ownership-isolation, and publish/unpublish checks are complete in `collabflow-dev`. The report does not establish that every local SQL assertion was repeated on Supabase or that real Auth/PostgREST HTTP integration and authenticated browser interactions passed.
- Vercel production tests remain pending because M2A.1 has not been deployed. The 10 local HTTP tests exercise `next start` with a fixture database, not Vercel's edge/CDN behavior. Origin responses are explicitly non-cacheable; confirm hosting configuration after a separately approved release.
- Publication intentionally makes the approved fields public and enumerable. Unpublishing prevents subsequent uncached reads; it cannot retract previously downloaded content.
- Public requests perform a database lookup. Database retries contributed roughly seven seconds to the fixture's simulated 503 case; load/latency testing and rate limits were not added in this milestone.
- The existing non-failing Node and Next configuration warnings remain as recorded above.

## Changed-file inventory

| Files | Purpose |
| --- | --- |
| [Creator actions](../app/(creator)/actions.ts), [dashboard](../app/(creator)/dashboard/page.tsx), [onboarding](../app/(creator)/onboarding/page.tsx), [publication form](../components/profile-publication-form.tsx) | Explicit publication workflow and user feedback |
| [Profile domain](../lib/creator/profile.ts), [publication domain](../lib/creator/publication.ts) | Owner publication state, verified owner-only updates |
| [Public page](../app/c/[slug]/page.tsx), [not-found fallback](../app/c/[slug]/not-found.tsx), [error boundary](../app/c/[slug]/error.tsx) | Approved public fields and safe rendering fallbacks |
| [Proxy](../proxy.ts), [auth policy](../lib/auth/policy.ts) | Exact public creator route boundary; preserve M1 route guards |
| [Public lookup](../lib/creator/public-profile.ts), [snapshot encoding](../lib/creator/public-request.ts), [HTTP response](../lib/creator/public-response.ts), [error document](../lib/creator/public-status.ts), [anonymous client](../lib/supabase/public.ts) | Safe public read, response status, header boundary, no persistent cache |
| [Migration](../supabase/migrations/20261119000200_public_creator_profiles.sql), [SQL authorization checks](../supabase/tests/public_creator_profiles_rls.sql) | Publication projection, least privilege, transactional lifecycle checks |
| [Public unit tests](../tests/public-profiles.test.mjs), [database tests](../tests/public-profiles-database.test.mjs), [HTTP tests](../tests/integration/public-profiles.http.mjs), [auth-policy tests](../tests/auth-policy.test.mjs) | Publication and M1 regression evidence |
| [Package scripts](../package.json), [lockfile](../package-lock.json) | HTTP test command and development-only embedded PostgreSQL dependency |
| [README](../README.md), [this guide](./milestone-2a-1.md) | Implementation, verification, risks, and future migration procedure |
