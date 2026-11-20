# M2A.3A: read-only creator inbox

Implemented locally after checkpoint `2f8e0a0`. No hosted SQL, schema exposure,
Cron, deployment, feature flag, or credentials were changed. This milestone is
not committed. The unrelated local patch was left untouched.

## Product behavior

- Dashboard links to `/dashboard/inquiries`.
- List shows sender name, optional company, UTC received time and a 240-character
  preview. Detail at `/dashboard/inquiries/[id]` shows email and full plain-text
  message as well. React escapes content; no HTML rendering or automatic links.
- Pages contain 20 entries, newest first, with Older and Newest navigation.
  A timestamp/UUID cursor avoids large offsets and preserves PostgreSQL
  microseconds. An extra row detects whether another page exists; no total count.
- Loading, empty, invalid cursor, temporary error and unavailable detail states
  are included. Missing/expired sessions go to login; users without a creator
  profile go to onboarding. Unknown and foreign-owned detail IDs look identical.
- Reading is independent of publication and the public submission feature flag.
  Existing inquiries remain readable when a profile is unpublished or intake is
  disabled. This does not enable submission, status changes, replies or deletion.

## Security and database design

The new, **unapplied** [migration](../supabase/migrations/20261120000200_creator_inbox.sql)
adds one SELECT policy to the existing private inquiry table and one composite
owner/timestamp/ID index. Existing migrations are unchanged. All six private
tables retain ENABLE and FORCE RLS.

Authenticated users receive schema USAGE plus column-scoped SELECT on only the
inquiry fields needed by the inbox (including the owner key needed for filtering).
The policy joins `creator_public_id` to the signed-in user's `creator_profiles`
row using `auth.uid()`. There is no publication requirement. No metadata-table
access, write access, cleanup access, new role or role membership is granted.

Two public-schema RPCs, `list_creator_inquiries` and `get_creator_inquiry`, use
SECURITY INVOKER, STABLE, an empty search path and qualified relations. Both
explicitly filter by `auth.uid()` in addition to RLS. PUBLIC, anon, service_role
and intake roles cannot execute them; only authenticated receives EXECUTE.
There is no owner/user parameter. List limits are validated in SQL (1–21), and
cursor pairs must be complete and finite. Detail returns at most one row.
All statements are static SQL; UUID/date parameters are typed.

**Keep `collabflow_private` excluded from Data API exposed schemas.** Public RPC
entry points can use non-exposed tables under invoker permissions. Schema USAGE
is not schema exposure. Direct SQL by an authenticated role still obeys RLS;
these grants intentionally allow that role to read its own inquiry columns.
Exposure is a hosted setting that was not inspected or modified locally and
must be confirmed before rollout.

The server creates a fresh cookie-scoped Supabase client and verifies identity
with `auth.getUser()` before profile/RPC access. It never uses the inquiry writer
connection or service-role credentials. Unknown list query keys (including
forged creator IDs) and malformed cursors are rejected. Cursors choose a position
only; modifying one cannot change the owner. Response objects explicitly select
approved fields; previews omit email/full message. Errors do not serialize or
log upstream details or submitted content.

Inbox responses, including authentication redirects and RSC responses, receive
`Cache-Control: private, no-store, max-age=0` and noindex headers in the proxy.
Cookie reads and RPC calls remain request-time work inside Suspense; there is no
`use cache` or shared result/client instance. Detail and pagination links disable
prefetch. Partial prerendering contains only generic loading/layout content.
As with other private screens, an authorized user's browser displays the data;
this is not a mechanism to prevent that user from retaining copies.

## Local verification

- [Reader tests](../tests/inbox.test.mjs): verified-session requirement,
  expired sessions, onboarding/empty/error states, safe projection, bounded
  pagination, microsecond cursors and forged owner parameters.
- [PGlite tests](../tests/inbox-database.test.mjs): apply all migrations only to
  disposable in-memory PostgreSQL; check A/B ownership through RPC and direct
  SQL, anonymous/no-identity denials, tied timestamps, bounds, invoker/grants,
  FORCE RLS, metadata/write denial, public projection and intake/cleanup regression.
- [Production HTTP fixture](../tests/integration/inbox.http.mjs): real Next build
  with synthetic Auth/PostgREST on loopback; checks owner HTML, escaped message,
  list projection, cross-session HTML/RSC isolation, expired login, pagination,
  safe failures, no-store and public-response privacy. The fixture is not a real
  hosted Auth/PostgREST service; database authorization is tested separately.
- [Existing HTTP regressions](../tests/integration/public-profiles.http.mjs)
  additionally check signed-out inbox routes remain protected.

Build/HTTP validation uses ignored `.next/validation-m2a3a` with explicit source
and configuration allowlists, a junction to installed dependencies and a newly
created dummy environment file. No existing environment file is read/copied.
The build's public Supabase URL is `http://127.0.0.1:54321`; the inbox fixture must
bind that same loopback port because the existing auth client inlines public
configuration at build time. For another isolated build port set
`COLLABFLOW_HTTP_AUTH_PORT` accordingly. If occupied, choose another port and
rebuild the isolated copy; do not stop another service or connect to hosted Auth.

### Recorded results (2026-11-20)

| Check | Result |
| --- | --- |
| `npm test` | 184 passed, zero failures; includes disposable PGlite authorization and existing milestone regressions. |
| `npm run lint` | Passed. |
| `npm run typecheck` | Passed. |
| `npm run build` in the isolated copy | Passed; inbox list/detail routes included. |
| `npm run test:http` against the isolated production build | 30 passed, zero failures. |

These are independently executed local checks, not hosted verification. Initial
fixture failures were corrected: seed whitespace, the build-time Auth port,
relative redirects and Next's RSC URL normalization. Final runs above passed.
Existing build warnings about workspace-root inference and partial prefetching,
and Node's test module-type warning, remain non-blocking. No dependencies were
installed. Browser visual/accessibility checks and real hosted Auth/PostgREST,
concurrency and load validation remain pending.

### Final pagination and SSR follow-up (2026-11-21)

Cursor validation now checks Gregorian month lengths and leap-year rules,
clock fields and PostgreSQL numeric offset bounds directly. Nonexistent dates
return `invalid` before the inquiry RPC. Original strings, including six-digit
microseconds and timezone offsets, are preserved without Date normalization.
A reader-to-PostgreSQL regression additionally pages through 25 records spaced
one microsecond apart, checks exact ordering with no skipped/duplicate records,
and verifies an equivalent offset cursor spanning the leap-day boundary.

The outer inbox proxy already sets private/no-store after `updateSession`,
including redirects. Review of installed `@supabase/ssr` 0.12.7 found that the
shared proxy adapter discarded the cache headers supplied to `setAll`. The
adapter now applies them, preserves them and earlier cookies across response
recreation, and carries Cache-Control/Expires/Pragma onto login redirects.
This also protects session-refresh responses on other routes using the adapter.
Authorization and the server-component client remain unchanged. Clients are
request-local; inquiry RPCs use POST, with no `use cache` boundary around reads.
HTTP tests verify successful refresh reaches rendering without a second refresh,
cookie clearing survives failed-refresh redirects, and private headers remain
present. See [Supabase's SSR caching guidance](https://supabase.com/docs/guides/auth/server-side/advanced-guide).

Final local checks for this follow-up:

| Check | Result |
| --- | --- |
| `node --experimental-strip-types --test tests/inbox.test.mjs tests/inbox-database.test.mjs` | 14 passed. |
| `npm test` | 187 passed, zero failures/skips. |
| `npm run lint` / `npm run typecheck` | Both passed. |
| `npm run build` in fresh `.next/validation-m2a3a-followup-20261121` | Passed. |
| `npm run test:http` in that isolated copy | 33 passed, zero failures/skips. |
| Editor diagnostics / `git diff --check` | No errors. |

The fresh build copy uses the same allowlisted source/configuration procedure
and new dummy environment described above; existing environment files were not
read or copied. Existing module-type, partial-prefetching and nested-lockfile
warnings remain. The HTTP suite's enabled-intake scenario is synthetic only;
no project environment or feature flag was changed. Hosted SQL, real Auth/CDN,
multi-connection PostgreSQL concurrency/load, and browser visual/accessibility
checks were not performed. Applied migrations, the new unapplied inbox migration,
and the unrelated patch remain unchanged; no dependencies were installed.

## Remaining rollout steps (separate approval)

1. Review and apply **only** `20261120000200_creator_inbox.sql` through the approved
   administrative process. Never replay the applied inquiry/retention migrations.
   This is an additive, single-application migration, not an activation script.
   Index creation briefly locks writes; it has a five-second lock timeout and a
   60-second statement timeout. Retry in an appropriate window if needed.
2. Confirm `collabflow_private` remains excluded from Data API exposure; confirm
   the two RPCs are available through the existing public schema/schema cache.
   Validate effective column grants, owner SELECT policy, FORCE RLS and absence
   of metadata/write/cleanup privileges for authenticated and anonymous roles.
3. With two approved staging users, test real Auth and PostgREST RPC ownership,
   missing/expired sessions, unpublished creator access and denied foreign IDs.
   Validate actual private HTML/RSC/cache headers behind deployment ingress.
4. Validate responsive UI, keyboard navigation and error-boundary recovery in a
   browser, and test a representative dataset/query plan. PGlite is single-session;
   it does not certify live concurrency or hosted permission defaults.
5. Deploy only after separate approval. Without the new migration the inbox
   fails safely with an availability state; deploy after the database step.
   Keep `INQUIRIES_ENABLED=false` and permanent Cron jobs unscheduled until their
   independent activation gates pass. M2A.2B load/concurrency/monitoring gates
   remain unchanged. This milestone does not activate anything.

Cursor pages are not snapshots: arrivals appear on Newest, and retention or
account deletion can remove records between requests. Missing details safely
show unavailable. A streamed not-found state can have HTTP 200 after headers
have been sent; it never includes foreign inquiry data and remains no-store.

References: [Supabase function security](https://supabase.com/docs/guides/database/functions)
and [Next Cache Components](https://nextjs.org/docs/app/getting-started/cache-components).
