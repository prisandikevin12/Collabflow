# CollabFlow

Milestone 1 adds private creator profiles, onboarding, and a protected dashboard using the existing Supabase authentication flow.

The M1 migration has already been applied to Supabase. See the [Milestone 1 implementation and verification guide](./docs/milestone-1.md) for the original implementation, checks, and file inventory; its migration-status notes describe the earlier local-only stage.

Milestone 2A.1 adds opt-in public creator profiles and publish/unpublish controls. Its migration has been applied successfully to the `collabflow-dev` Supabase project. The code and database security review is complete, and the implementation is conditionally approved. Existing profiles remain private; hosted database checks confirmed enabled/forced RLS on both tables, a projector without LOGIN or BYPASSRLS, anonymous read-only access to approved public columns, ownership isolation between two existing creator accounts, and transactional publish/unpublish behavior. The test transaction was rolled back.

Local verification passed 97 automated tests and 10 HTTP integration tests against a local production build, plus ESLint, TypeScript, and the production build. These results are separate from the real Supabase database checks. M2A.1 application code is committed in `71521a1`; Vercel production HTTP, browser, and CDN checks remain pending. See the [Milestone 2A.1 implementation and verification guide](./docs/milestone-2a-1.md) for the evidence, remaining checks, and migration instructions for other unapplied environments. Do not reapply migrations already installed in `collabflow-dev`.

Milestone 2A.2 continues the existing inquiry-intake work with a public form, server-verified Turnstile, durable database quotas, idempotent receipts, restricted database roles, and regression tests. The project owner reports that inquiry migration `20261119000300` has been applied manually to hosted Supabase and production configuration is present; `INQUIRIES_ENABLED=false`. See the [Milestone 2A.2 implementation and validation guide](./docs/milestone-2a-2.md) for scope, security boundaries, required rollout checks, and safe local validation. The creator inbox and automation remain future work.

Milestone 2A.2B adds a 180-day retention policy for new inquiries, bounded private cleanup, regression tests, and separately gated Cron operations. The project owner reports that retention migration `20261120000100` has also been applied manually, Supabase pg_cron is installed, and basic Cron and maintenance-role smoke tests succeeded. The six permanent cleanup jobs have not been activated or scheduled. Actual production cleanup execution, full concurrency/load validation, monitoring rollout, and production activation remain pending. These hosted results were reported by the owner, not independently verified by Codex; Codex performed the separately documented local automated checks. See the [retention and operations runbook](./docs/milestone-2a-2b.md). Existing inquiries require separate review and are excluded from automatic retention.

The original starter documentation follows for reference.

<a href="https://demo-nextjs-with-supabase.vercel.app/">
  <img alt="Next.js and Supabase Starter Kit - the fastest way to build apps with Next.js and Supabase" src="https://demo-nextjs-with-supabase.vercel.app/opengraph-image.png">
  <h1 align="center">Next.js and Supabase Starter Kit</h1>
</a>

<p align="center">
 The fastest way to build apps with Next.js and Supabase
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#demo"><strong>Demo</strong></a> ·
  <a href="#deploy-to-vercel"><strong>Deploy to Vercel</strong></a> ·
  <a href="#clone-and-run-locally"><strong>Clone and run locally</strong></a> ·
  <a href="#feedback-and-issues"><strong>Feedback and issues</strong></a>
  <a href="#more-supabase-examples"><strong>More Examples</strong></a>
</p>
<br/>

## Features

- Works across the entire [Next.js](https://nextjs.org) stack
  - App Router
  - Pages Router
  - Proxy
  - Client
  - Server
  - It just works!
- supabase-ssr. A package to configure Supabase Auth to use cookies
- Password-based authentication block installed via the [Supabase UI Library](https://supabase.com/ui/docs/nextjs/password-based-auth)
- Styling with [Tailwind CSS](https://tailwindcss.com)
- Components with [shadcn/ui](https://ui.shadcn.com/)
- Optional deployment with [Supabase Vercel Integration and Vercel deploy](#deploy-your-own)
  - Environment variables automatically assigned to Vercel project

## Demo

You can view a fully working demo at [demo-nextjs-with-supabase.vercel.app](https://demo-nextjs-with-supabase.vercel.app/).

## Deploy to Vercel

Vercel deployment will guide you through creating a Supabase account and project.

After installation of the Supabase integration, all relevant environment variables will be assigned to the project so the deployment is fully functioning.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fnext.js%2Ftree%2Fcanary%2Fexamples%2Fwith-supabase&project-name=nextjs-with-supabase&repository-name=nextjs-with-supabase&demo-title=nextjs-with-supabase&demo-description=This+starter+configures+Supabase+Auth+to+use+cookies%2C+making+the+user%27s+session+available+throughout+the+entire+Next.js+app+-+Client+Components%2C+Server+Components%2C+Route+Handlers%2C+Server+Actions+and+Middleware.&demo-url=https%3A%2F%2Fdemo-nextjs-with-supabase.vercel.app%2F&external-id=https%3A%2F%2Fgithub.com%2Fvercel%2Fnext.js%2Ftree%2Fcanary%2Fexamples%2Fwith-supabase&demo-image=https%3A%2F%2Fdemo-nextjs-with-supabase.vercel.app%2Fopengraph-image.png)

The above will also clone the Starter kit to your GitHub, you can clone that locally and develop locally.

If you wish to just develop locally and not deploy to Vercel, [follow the steps below](#clone-and-run-locally).

## Clone and run locally

1. You'll first need a Supabase project which can be made [via the Supabase dashboard](https://database.new)

2. Create a Next.js app using the Supabase Starter template npx command

   ```bash
   npx create-next-app --example with-supabase with-supabase-app
   ```

   ```bash
   yarn create next-app --example with-supabase with-supabase-app
   ```

   ```bash
   pnpm create next-app --example with-supabase with-supabase-app
   ```

3. Use `cd` to change into the app's directory

   ```bash
   cd with-supabase-app
   ```

4. Rename `.env.example` to `.env.local` and update the following:

```env
NEXT_PUBLIC_SUPABASE_URL=[INSERT SUPABASE PROJECT URL]
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=[INSERT SUPABASE PROJECT API PUBLISHABLE OR ANON KEY]
```

> [!NOTE]
> This example uses `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, which refers to Supabase's new **publishable** key format.
> Both legacy **anon** keys and new **publishable** keys can be used with this variable name during the transition period. Supabase's dashboard may show `NEXT_PUBLIC_SUPABASE_ANON_KEY`; its value can be used in this example.
> See the [full announcement](https://github.com/orgs/supabase/discussions/29260) for more information.

Both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` can be found in [your Supabase project's API settings](https://supabase.com/dashboard/project/_?showConnect=true)

5. You can now run the Next.js local development server:

   ```bash
   npm run dev
   ```

   The starter kit should now be running on [localhost:3000](http://localhost:3000/).

6. This template comes with the default shadcn/ui style initialized. If you instead want other ui.shadcn styles, delete `components.json` and [re-install shadcn/ui](https://ui.shadcn.com/docs/installation/next)

> Check out [the docs for Local Development](https://supabase.com/docs/guides/getting-started/local-development) to also run Supabase locally.

## Feedback and issues

Please file feedback and issues over on the [Supabase GitHub org](https://github.com/supabase/supabase/issues/new/choose).

## More Supabase examples

- [Next.js Subscription Payments Starter](https://github.com/vercel/nextjs-subscription-payments)
- [Cookie-based Auth and the Next.js 13 App Router (free course)](https://youtube.com/playlist?list=PL5S4mPUpp4OtMhpnp93EFSo42iQ40XjbF)
- [Supabase Auth and the Next.js App Router](https://github.com/supabase/supabase/tree/master/examples/auth/nextjs)
