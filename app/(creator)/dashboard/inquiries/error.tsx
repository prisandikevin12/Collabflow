"use client";

import { Button } from "@/components/ui/button";

export default function InboxError({ reset }: { reset: () => void }) {
  return <section role="alert" className="rounded-xl border bg-background p-6 sm:p-8">
    <h1 className="text-2xl font-semibold">Inbox temporarily unavailable</h1>
    <p className="my-4 text-muted-foreground">We couldn’t load your inquiries. Please try again.</p>
    <Button onClick={reset}>Try again</Button>
  </section>;
}
