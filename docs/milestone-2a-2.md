# Milestone 2A.2: collaboration inquiry intake

**Current status (M2A.2B):** M2A.1 is committed in `71521a1`. The project owner reports that inquiry migration `20261119000300` and retention migration `20261120000100` have both been manually applied to hosted Supabase, writer permissions/pooler TLS checks passed, and Supabase pg_cron is installed. The owner successfully ran a temporary Cron smoke job and maintenance-role checks for all five cleanup targets inside a transaction followed by ROLLBACK; each cleanup call returned zero. The six permanent cleanup jobs remain unactivated/not scheduled, and `INQUIRIES_ENABLED=false`. These hosted results are owner-reported, not independently verified by Codex. Codex performed the local automated checks documented below and in [M2A.2B](./milestone-2a-2b.md). Actual production cleanup execution, full concurrency/load validation, monitoring rollout, and production activation remain pending. Do not modify or reapply either migration or run a database push.

Implementation began from HEAD `71521a1` and the existing uncommitted intake work. Existing dependency additions (`postgres`, `server-only`), the exact public endpoint exemption, HTTP regressions, and `collabflow-m2a1.patch` were preserved. No dependencies were installed during this continuation.

This milestone implements public submission and private persistence. The creator inbox, inquiry status management, AI, notifications, and email sending are not implemented. Codex performed no hosted migration, cloud configuration, push, or deployment during implementation. The owner-reported hosted operations above are separate from local development and the authorized local Git checkpoint. The feature remains disabled pending explicit activation approval.

## Request flow

1. A published `/c/[slug]` page renders the form only when `INQUIRIES_ENABLED=true` and a public `TURNSTILE_SITE_KEY` is configured. Its creator ID comes from the existing server-verified public projection, never a browser-supplied profile header.
2. The visitor fills in name, email, optional company, and proposal, prepares verification, then submits. Editing invalidates the challenge. Each unchanged payload retains a random submission UUID for retries in the same mounted form, including ambiguous/lost responses. Nothing is stored in localStorage or cookies.
3. The POST endpoint validates feature configuration, an exact allowed Origin, Fetch Metadata, the trusted Vercel IP header, JSON content type, actual streamed body size (32 KiB), a five-second read deadline, and normalized bounded fields. Unknown fields, malformed IDs/slugs, invalid UTF-8, controls, and the honeypot are rejected. No raw error or submitted content is logged or echoed.
4. A restricted database connection reserves an expiring attempt after durable preflight quotas. IPs are HMAC-hashed, with IPv6 grouped by /64 and IPv4-mapped IPv6 normalized. Emails and payloads have separate HMAC purposes. Raw IPs and challenge tokens are not stored.
5. Server-side Turnstile validation checks success, exact hostname, action, and `creatorPublicId_submissionId` binding. The request is bounded by a timeout, cannot follow redirects, and contains no contact details or proposal. Provider/configuration failures return a safe 503; invalid challenges return 403.
6. A second database function locks the attempt and submission identity, rechecks and locks publication, enforces accepted-submission quotas, claims a unique token digest, then inserts the inquiry and receipt atomically. A renamed/unpublished/deleted profile cannot receive a new inquiry using stale form data.
7. An unchanged retry returns the existing receipt without verifying an already-consumed token or creating another inquiry. Conflicting payloads using the same submission ID return 409. Editing or reloading creates a new logical submission; identical content with a new ID is subject to quotas, not deduplicated by content.

The form requires JavaScript, handles expired/failed/unsupported challenges, preserves entered values after failures, disables double submission, and requires a fresh challenge after an attempted send. HTTP 200 is treated as success only with a valid receipt UUID. The receipt is an acknowledgement, not an inquiry-reading credential. All endpoint outcomes disable caching; unsupported methods return 405 with `Allow: POST`.

## Database security

The already-applied [inquiry migration](../supabase/migrations/20261119000300_collaboration_inquiries.sql) creates six private tables: inquiries, settings, attempts, rates, receipts, and token digests. All enable and force RLS. The existing creator policies and public projection remain unchanged.

- `collabflow_inquiry_writer`: LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS. No password is provisioned in the migration. It has no direct table privileges and can execute only `begin_inquiry_attempt` and `finish_inquiry` among the inquiry functions.
- `collabflow_inquiry_executor`: NOLOGIN, NOINHERIT, NOBYPASSRLS. Owns the intake functions but no tables. Its RLS policy and table grants allow only the operations needed by those functions. Inquiry content is insert-only even for this role.
- The existing publication projector owns a narrowly scoped publication-lock helper. The writer cannot execute this helper or the rate helper directly.
- Every security-definer function has an empty search path and schema-qualified application objects. Default PUBLIC execution is revoked; temporary role memberships and schema CREATE privileges are revoked at the end of the migration.
- Anonymous users, authenticated users, and the service role have no grants on the new private tables/functions. No service-role key is used. No PostgREST-exposed write RPC is added, so direct anonymous API calls cannot bypass Turnstile.
- The database URL must identify the restricted writer, use a PostgreSQL protocol, contain credentials, and contain no query or fragment. TLS certificate verification stays enabled. Transaction pooling uses no prepared statements and at most one connection per warm application process; fleet-wide connections still require pool sizing.

The writer is a trusted application credential: database functions cannot independently attest that Cloudflare was called. A compromised writer can invoke the two intake functions within their quotas, but cannot read inquiries or access private creator profiles through this implementation. Hosted effective privileges, including inherited PUBLIC grants and existing security-definer routines outside these migrations, need a separate staging review.

## Quotas and operational limits

| Scope | Fixed window | Limit |
| --- | --- | --- |
| All attempts | 1 hour | 10,000 |
| IP or IPv6 /64 attempts | 10 minutes | 20 |
| IP or IPv6 /64 attempts | 1 hour | 100 |
| All accepted-stage attempts | UTC day | 1,000 |
| Creator accepted-stage attempts | UTC day | 100 |
| IP or IPv6 /64 accepted-stage attempts | 1 hour | 5 |
| Email + creator accepted-stage attempts | UTC day | 3 |

Attempts and retries consume preflight quota. Accepted-stage denials count conservatively toward quota; this avoids rolling counters back on a rejected request. Fixed windows permit boundary bursts and shared networks can affect multiple visitors. The global cap bounds attacker-selected key allocation but can also deny legitimate traffic under abuse. HTTP 429 conservatively reports a 24-hour retry delay. These are initial limits to review before enabling.

Database counters and idempotency survive process restarts. SQL upserts, row locks, advisory transaction locks, and unique constraints enforce consistency; there is no in-memory production limiter. Platform-level request/concurrency limits remain necessary against volumetric attacks and must be separately approved/configured.

Attempt tickets expire after two minutes. Receipts and token records carry 24-hour expiry timestamps. Receipts deliberately continue to prevent duplicates until removed by administrator maintenance; token records likewise continue to block replay. Rate rows expire after their window plus a day. Expiry indexes support bounded cleanup, but **none of the six permanent cleanup jobs is activated or scheduled**; pg_cron itself is already installed according to the owner. Before public activation, approve an administrator-run cleanup schedule that deletes only expired metadata in small batches, monitors growth, and preserves at least the promised retry/replay windows. Never grant metadata deletion to the public intake writer.

The original inquiry migration initialized `retention_days` to NULL. The subsequently applied retention migration sets it to 180 for new inquiries and protects legacy/NULL-deadline records from automatic cleanup. The owner reports `retention_effective_at = 2026-11-20 06:59:45 UTC`. Cleanup functions and opt-in operational scripts are available, but permanent jobs remain unscheduled. Unpublishing preserves received inquiries; deleting the creator account still cascades inquiry deletion. See [M2A.2B](./milestone-2a-2b.md) for the current retention, metadata cleanup, and legacy-record policy.

## Configuration and activation require approval

Do not read or modify the existing local environment file for this work. Configure secrets only through approved tooling; do not paste them into chat, source, SQL migrations, or shared logs.

| Variable | Purpose |
| --- | --- |
| `INQUIRIES_ENABLED` | Defaults disabled; only exact `true` enables submission. |
| `TURNSTILE_SITE_KEY` | Public widget key; the page passes only this key to the browser. |
| `TURNSTILE_SECRET_KEY` | Server-only Siteverify secret. |
| `TURNSTILE_ALLOWED_HOSTNAMES` | Comma-separated exact hostnames authorized for the widget. |
| `INQUIRY_ALLOWED_ORIGINS` | Comma-separated exact origins, including scheme and optional port. No wildcard suffix matching. |
| `INQUIRY_HMAC_SECRET` | Server-only random high-entropy secret, at least 32 characters. Rotation affects rate identities and receipt fingerprints; plan it deliberately. |
| `INQUIRY_DATABASE_URL` | Server-only connection for `collabflow_inquiry_writer` (pooler username may include the project suffix). Never use postgres/admin/service-role credentials. |
| `INQUIRY_DATABASE_CA` | Optional trusted database CA PEM for TLS; verification is never disabled. |
| `VERCEL` | Platform-provided `1`, not an application override outside Vercel. |

The IP trust boundary assumes direct Vercel ingress and its overwritten `x-vercel-forwarded-for` header. There is deliberately no fallback to client-controlled `x-forwarded-for`, `x-real-ip`, or a shared default IP. A non-Vercel production host or an additional upstream proxy needs an explicit trusted-ingress design; setting `VERCEL=1` locally does not establish that trust. Automated tests use that flag only with synthetic loopback requests and dummy configuration.

Before activation:

1. Review the remaining production activation gates: cleanup, quotas, full concurrency/load validation, monitoring rollout, and disclosure. Keep intake disabled.
2. Both migrations `20261119000300` and `20261120000100` are already applied in the current project; do not modify or reapply them or run a database push. Migration instructions in [M2A.2B](./milestone-2a-2b.md) apply only to other unapplied environments. Cron activation requires separate approval.
3. Preserve the owner-verified writer provisioning and pooler/TLS configuration. Complete any remaining effective-privilege, connection-limit, timeout, and staging checks before production activation; do not reprovision credentials solely for this checkpoint.
4. Production variables are already configured according to the owner. Validate Turnstile and exact allowed hostnames/origins through the separately approved rollout process. Approve request-level abuse protection and monitoring. Avoid logging PII, tokens, SQL parameters, or connection strings.
5. Run real staging tests with multiple database connections: duplicate requests, competing payloads, publication changes during submission, token replay, rate-window boundaries, and privilege denials. Verify trusted headers through the actual ingress, not just a Node fixture.
6. Test the browser widget, expired/rejected tokens, narrow layouts, keyboard navigation, retries after lost responses, and existing authentication/profile flows. Verify the promised retention/contact disclosure before public activation.
7. Enable only after these checks. Application deployment and cloud settings still require separate approval.

## Local validation

The following results were obtained locally by Codex during the M2A.2 implementation pass. They are historical local evidence, not hosted verification or tests rerun for the documentation/Git checkpoint. The [M2A.2B runbook](./milestone-2a-2b.md) records the later 173-test regression pass and the skipped multi-session PostgreSQL test.

The existing test runner and PGlite dependency are reused. [Intake tests](../tests/inquiries.test.mjs) exercise validation, body bounds/timeouts, trusted-header handling, HMAC normalization, Turnstile bindings/failures, ordering, safe errors and retries. [Database tests](../tests/inquiries-database.test.mjs) apply all migrations to disposable in-memory PostgreSQL and check real grants/RLS, direct-write denial, quotas, interleaved duplicates, token replay, stale publication, constraints, retention behavior and account deletion. They also rerun the original M1/M2A.1 SQL assertions. [Client tests](../tests/inquiry-client.test.mjs) check stable retry IDs, changed-payload IDs, action parity and receipt validation.

PGlite is single-connection PostgreSQL: interleaved pending attempts are exercised, but these tests do not prove live multi-connection lock scheduling, hosted default privileges, PostgREST behavior, pooler/TLS configuration, or real Cloudflare/Vercel behavior. Test doubles replace Siteverify in unit tests; no production verification bypass exists.

The [HTTP suite](../tests/integration/public-profiles.http.mjs) starts the production Next.js server with a local public-profile fixture and dummy configuration, with inquiries both disabled and enabled. It checks prior public/auth routes, disabled intake, enabled form rendering, field/secret separation, non-POST rejection, malformed submissions, origin/header enforcement and fail-closed database configuration. It refuses to start Next from a directory containing `.env.local` (existence check only).

Run unit tests, lint and type checking in the repository. Build and run HTTP tests in a fresh ignored source copy inside `.next/`, using explicitly selected source/configuration files, no existing environment files, and a junction to the already-installed dependencies. Use dummy public Supabase configuration in a newly created environment file inside that copy. Never run a normal Next build/start in the original project while access to its environment file is prohibited. The copy used for this continuation is `.next/validation-m2a2`.

| Command | Result |
| --- | --- |
| `npm.cmd test` | PASS: 142 tests, including original milestone regressions |
| `npm.cmd run lint` | PASS |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run build` in isolated copy | PASS: default Turbopack production build; 18 static-generation entries |
| `npm.cmd run test:http` in isolated copy | PASS: 23 tests, enabled and disabled intake configurations |
| Editor diagnostics and `git diff --check` | PASS |

Verification completed on 2026-11-20. The first build exposed an inherited route-config incompatibility: an explicit `runtime = "nodejs"` segment setting is unsupported with this project's Cache Components option. Removing that redundant setting preserves the default Node runtime and the subsequent build passed. No other Next configuration was changed. HTTP fixture servers shut down after the suite.

Existing non-failing module-type and partial-prefetching warnings remain. The isolated nested source copy may also cause a workspace-root/lockfile warning. The editor build-task tool is unavailable (`No invocation context`), so validation uses the terminal.

## References checked

- [Cloudflare server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/): tokens require server verification; hostname/action/custom-data checks and the local replay ledger complement provider validation.
- [Cloudflare widget configuration](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/): explicit rendering and expiration/error callbacks.
- [Vercel request headers](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for): deployment-specific IP-header trust assumptions.
