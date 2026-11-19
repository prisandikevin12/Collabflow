"use client";

import { Button } from "@/components/ui/button";

export default function CreatorError({ reset }: { reset: () => void }) {
  return (
    <section className="mx-auto max-w-lg rounded-xl border bg-background p-8" role="alert">
      <h1 className="text-2xl font-semibold">Your workspace couldn’t load</h1>
      <p className="my-4 text-sm leading-relaxed text-muted-foreground">We couldn’t retrieve your profile. Please try again in a moment.</p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
