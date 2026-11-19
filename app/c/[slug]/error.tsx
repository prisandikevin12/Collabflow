"use client";

import { Button } from "@/components/ui/button";

export default function PublicProfileError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">This page couldn’t load</h1>
      <p className="my-4 text-muted-foreground">Please try again in a moment.</p>
      <Button onClick={reset} className="self-start">Try again</Button>
    </main>
  );
}
