# Milestone 1: creator onboarding and dashboard

Implemented locally on top of foundation commit `aeafb39`. No migration has been applied, no hosted settings changed, and no commit, push, or deployment performed. The existing environment file and Supabase client factories are unchanged.

## Behavior

- Signed-out visitors to `/dashboard`, `/onboarding`, and `/protected` go to `/auth/login`. The existing proxy strips query parameters from this redirect and preserves refreshed cookies.
- Sign-in and password updates lead to `/dashboard`. The server sends accounts without a profile to `/onboarding`; accounts with a profile cannot repeat onboarding.
- `/protected` remains compatible with existing confirmation emails and bookmarks. Signup still uses the existing `/protected` email destination, so no Supabase URL configuration change is needed.
- Signed-in visitors to `/`, `/auth/login`, and `/auth/sign-up` enter the same dashboard/onboarding flow. Recovery and confirmation validation are preserved. The exact redirect allowlist adds only `/dashboard` and `/onboarding`; its existing safe fallback remains `/`.
- Server reads and every write verify the current user using the existing cookie-scoped Supabase client. Submitted owner IDs, timestamps, and previous action state are ignored.
- Database read failures show a retry screen instead of being interpreted as a missing profile. Save failures retain the entered values and show a safe message.
- `/c/{slug}` is displayed as a planned, site-relative collaboration URL. There is no configured production domain or public profile route yet. Profile data remains private.

## Profile rules

| Field | Rules |
| --- | --- |
| Display name | Trimmed, 2–60 Unicode code points, no control characters |
| Slug | Trimmed and lowercased by the application; 3–40 ASCII letters/digits; single internal hyphens; reserved words rejected |
| Bio | Optional, trimmed, up to 280 Unicode code points on one line; blank saves as SQL NULL |
| Ownership | One row per Auth user; owner derived from authenticated session |
| Timestamps | Database-managed creation time and update trigger; clients cannot write either timestamp |

The database independently rejects invalid slugs rather than normalizing direct API submissions. The unique constraint arbitrates concurrent slug claims. Onboarding uses INSERT, never UPSERT: a repeated request cannot overwrite an existing profile. A unique conflict is followed by an own-profile read to distinguish concurrent creation from an occupied slug without exposing another user's details. Slug availability is inherently disclosed by trying to claim a slug; there is no public profile search or availability endpoint.

## Safely apply the migration later

**Hosted application requires the owner's explicit approval. Nothing in this document is a record of application.**

1. Review [the migration](../supabase/migrations/20261119000100_creator_profiles.sql). It creates one table, three owner-only policies, and a timestamp trigger/function in a transaction. It revokes inherited PUBLIC/anon/authenticated table grants, then grants authenticated SELECT and column-scoped INSERT/UPDATE. No DELETE grant or public policy is created.
2. First use a disposable/local Supabase database. Confirm which database is targeted; do not use production credentials for local testing. A generic PostgreSQL database without Supabase's `auth.users`, `auth.uid()`, and roles is insufficient.
3. With an approved local connection already stored securely outside the repository, apply the file once. For PowerShell with `psql` installed:

   ```powershell
   psql "$env:LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261119000100_creator_profiles.sql
   ```

   Keep connection secrets out of source control, screenshots, and shared logs. The migration is intentionally not idempotent: an existing table should stop application rather than conceal schema drift.
4. Create two disposable accounts through Supabase Auth and run the RLS checks below. Then complete the browser checklist. Check the constraints, policies, column grants, and timestamp behavior before considering hosted use.
5. After explicit approval, verify the hosted project identity and backup/recovery plan. Use the team's normal tracked Supabase migration workflow. If using the SQL editor instead, paste only this reviewed migration and record the filename/date in the team's migration ledger; reconcile migration history before any later CLI push. Do not blindly run a command that applies every pending migration.
6. Apply the schema before releasing the application changes. Without it, authenticated workspace pages show a load error. If SQL fails, stop and inspect the transaction error; do not delete constraints or loosen RLS to make it pass.
7. Recheck the policies/grants and the two-user authorization cases in an approved staging environment. A later rollback must preserve creator data: prefer a forward fix or an application rollback. Dropping the table would destroy profiles and requires a separate decision.

No service-role API key is needed in the application or these checks. The SQL script uses a database administrator connection only to establish test roles and JWT claims in a controlled test session.

## Two-user RLS verification

[The executable SQL test](../supabase/tests/creator_profiles_rls.sql) requires `psql`, the applied migration, and two existing Auth users with no profiles. It refuses identical users or accounts with existing profiles. All writes run inside a transaction that is rolled back; errors stop the script, and disconnecting rolls back an open transaction.

```powershell
psql "$env:LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -v user_a=USER_A_UUID -v user_b=USER_B_UUID -f supabase/tests/creator_profiles_rls.sql
```

It switches to the actual `authenticated` and `anon` PostgreSQL roles and sets each test user's JWT subject. It verifies:

- A can insert/read/update only A's profile; B can insert/read only B's profile.
- A cannot read/update B, and B cannot read/update A. Cross-owner UPDATE affects zero rows.
- A cannot insert a row owned by B; owner/timestamp changes and DELETE are denied by privileges.
- A cannot create a second profile. B cannot claim A's slug despite being unable to read A's row.
- Direct SQL rejects reserved, uppercase, malformed, and overlong slugs.
- Anonymous SELECT, INSERT, and UPDATE are denied.

Also verify with two **real authenticated browser sessions** in separate browser profiles or one normal and one private window. On an approved local/staging project, use the existing publishable key and each user's own access token with the Supabase client or REST API. Keep tokens local and out of shared logs. Make the same reads/writes above, including unfiltered SELECT, an explicit other-user filter, forged owner insertion, a cross-owner update, and immutable-column updates. Expect own rows only, zero returned rows for cross-owner reads/updates, and permission/constraint errors for forbidden writes. Repeat with the publishable key and no user token: private table operations must fail. SQL role simulation complements this real-session test; it does not prove the login/token integration.

## Manual browser checklist

After applying the migration to an approved test environment, run `npm run dev` (Windows with restricted PowerShell scripts: `npm.cmd run dev`). Do not edit the existing environment file as part of this milestone. If using a separate local Supabase project, supply its public URL/key only to the test process through your normal local environment tooling.

1. Signed out, open `/dashboard`, `/onboarding`, and `/protected`. Each must land on login. Repeat with query parameters; none should be forwarded to login.
2. Register a fresh account and confirm its email using the existing flow. Expect onboarding. Log out and log back in before creating a profile; expect onboarding again. Recheck password recovery to ensure it still opens the password-update route.
3. Submit a short/blank display name, `admin`, `a--b`, and a bio over 280 characters. Check clear field errors, screen-reader announcements, keyboard focus visibility, and retained values. Turn off browser validation or submit a direct request when testing server-only limits.
4. Submit ` My-Studio ` with a valid name and optional bio. Expect saved slug `my-studio` and a redirect to dashboard. Check name, slug, and planned `/c/my-studio` URL. The URL is labeled not live and is not clickable.
5. Visit onboarding again; expect dashboard. Submit from two previously opened onboarding tabs; only one profile should exist and later submissions must not overwrite it.
6. Edit the profile. Verify successful feedback and updated dashboard name/URL, then reload to verify persistence. Clear the bio and verify it remains empty on reload. Confirm `created_at` is unchanged and `updated_at` advances after a later save.
7. In a separate browser session, create user B. Try A's slug during creation and editing; expect “already taken.” Simultaneous claims on the same unused slug must produce exactly one successful claim. Confirm B never sees A's private profile fields.
8. Log out and revisit protected pages (including browser Back then refresh). Expire a session before submitting an open form; no write should occur, and the user should return to login. A revoked session must not bounce repeatedly between login and dashboard.
9. In a disposable local environment, simulate a database failure. Check the workspace retry screen and safe save-error message; a failure must not be treated as an absent profile. Restore access and retry.
10. At 375px and desktop widths, check header navigation, wrapping of long names/slugs, field labels, error text, pending disabled controls, and the inquiry empty state. Complete the form by keyboard. No inquiry management or AI features are present.

## Verification recorded on 2026-11-19

| Check | Actual result |
| --- | --- |
| `npm.cmd run test` | PASS: 82 tests, 0 failures, 0 skipped |
| `npm.cmd run lint` | PASS, exit 0 |
| `npm.cmd run typecheck` | PASS, exit 0 |
| `npm.cmd run build` | PASS, exit 0; dashboard/onboarding use dynamic server content within Suspense |
| Production HTTP smoke checks | PASS: five protected-route/query variants return 307 to `/auth/login` without a query; `/`, login, and signup return 200 |
| Browser inspection | Public landing page renders with CollabFlow navigation and working route targets |
| Live migration and two-user SQL RLS test | NOT RUN: neither `psql` nor Docker is installed; hosted execution is prohibited pending approval |
| Authenticated browser create/edit and real-session RLS checks | NOT RUN: migration remains unapplied and no authenticated test accounts were supplied |

PowerShell's `npm.ps1` wrapper is disabled by the machine execution policy; `npm.cmd` successfully ran the same npm scripts without changing that policy. The editor build-task tool was unavailable, so the production build ran in the terminal. Tests emit Node's module-type inference warning; the build emits the existing `cacheComponents`/`partialPrefetching` warning. Neither causes a failure. Unit tests mock the Supabase boundary and static migration tests check guardrails; neither is evidence that RLS has passed on a running database.

## Changed-file inventory

| File | Change |
| --- | --- |
| [README.md](../README.md) | Adds a milestone guide entry point |
| [This guide](./milestone-1.md) | Application procedure, manual checks, limitations, results, and file inventory |
| [Migration](../supabase/migrations/20261119000100_creator_profiles.sql) | Table, constraints, owner RLS, restricted grants, timestamp trigger |
| [RLS SQL test](../supabase/tests/creator_profiles_rls.sql) | Rollback-only two-user and anonymous database checks |
| [Profile domain](../lib/creator/profile.ts) | Normalization, validation, typed form state, authenticated profile reads/writes and error mapping |
| [Creator server guard](../lib/creator/server.ts) | Session/profile checks and route decisions; distinguishes database failure |
| [Auth policy](../lib/auth/policy.ts) | Exact onboarding/dashboard allowlist additions and loop-free creator destinations |
| [Server actions](../app/(creator)/actions.ts) | Cookie-scoped create/update actions, revalidation, redirects |
| [Creator layout](../app/(creator)/layout.tsx) | Responsive shared header, navigation, skip link, and workspace shell |
| [Loading state](../app/(creator)/loading.tsx) | Accessible workspace loading feedback |
| [Error boundary](../app/(creator)/error.tsx) | Safe workspace error and retry action |
| [Onboarding page](../app/(creator)/onboarding/page.tsx) | Authenticated creator setup with completed-profile redirect |
| [Dashboard page](../app/(creator)/dashboard/page.tsx) | Profile summary/editing, planned URL, and future inquiry empty state |
| [Profile form](../components/creator-profile-form.tsx) | Shared accessible create/edit form with validation and pending states |
| [Auth-entry redirect](../components/auth-entry-redirect.tsx) | Sends already authenticated home/login/signup visitors to the workspace |
| [Login form](../components/login-form.tsx) | Replaces successful login route with dashboard and refreshes session UI |
| [Password-update form](../components/update-password-form.tsx) | Routes successful password updates to dashboard and refreshes |
| [Auth navigation](../components/auth-button.tsx) | Adds a dashboard entry instead of showing the account email |
| [Login page](../app/auth/login/page.tsx) | Adds authenticated entry routing within Suspense |
| [Signup page](../app/auth/sign-up/page.tsx) | Adds authenticated entry routing within Suspense |
| [Landing page](../app/page.tsx) | Replaces starter instructions with minimal CollabFlow entry and auth routing |
| [Root layout](../app/layout.tsx) | CollabFlow title and description |
| [Legacy protected page](../app/protected/page.tsx) | Routes existing confirmation links/bookmarks by profile state |
| [Legacy protected layout](../app/protected/layout.tsx) | Removes the obsolete starter shell for the redirect-only page |
| [Auth-policy tests](../tests/auth-policy.test.mjs) | Preserves security cases and adds creator routing/allowlist cases |
| [Profile tests](../tests/creator-profile.test.mjs) | Validation, normalized/reserved slugs, verified ownership, races, errors and redirects |
| [Migration tests](../tests/creator-migration.test.mjs) | Reserved-list parity and static privilege/RLS guardrails |
