import { Suspense } from "react";
import Link from "next/link";
import { AuthButton } from "@/components/auth-button";
import { AuthEntryRedirect } from "@/components/auth-entry-redirect";
import { EnvVarWarning } from "@/components/env-var-warning";
import { Button } from "@/components/ui/button";
import { hasEnvVars } from "@/lib/utils";

export default function Home() {
  return (
    <div className="min-h-svh">
      <Suspense><AuthEntryRedirect /></Suspense>
      <header className="border-b">
        <nav aria-label="Main navigation" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link href="/" className="text-xl font-semibold tracking-tight">CollabFlow.</Link>
          {hasEnvVars ? <Suspense><AuthButton /></Suspense> : <EnvVarWarning />}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
        <p className="mb-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Your creator workspace</p>
        <h1 className="max-w-2xl text-5xl font-semibold leading-tight tracking-tight sm:text-6xl">A home for your creative work.</h1>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">Set up your creator profile and choose your collaboration slug.</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Button asChild size="lg"><Link href="/auth/sign-up">Create your profile</Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="/auth/login">Sign in</Link></Button>
        </div>
      </main>
    </div>
  );
}
