import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { loadInbox } from "@/lib/inquiries/inbox-server";
import { inquiryDate } from "@/lib/inquiries/inbox";
import Loading from "./loading";

export const metadata: Metadata = { title: "Inbox | CollabFlow", robots: { index: false, follow: false } };
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function Inbox({ searchParams }: { searchParams: SearchParams }) {
  const result = await loadInbox(await searchParams);
  if (result.status === "unauthenticated") redirect("/auth/login");
  if (result.status === "onboarding") redirect("/onboarding");
  if (result.status === "error") throw new Error("Unable to load inbox.");
  if (result.status !== "ready") return <section role="alert" className="rounded-xl border bg-background p-6">
    <h1 className="text-2xl font-semibold">Invalid inbox page</h1>
    <Link href="/dashboard/inquiries" prefetch={false} className="mt-4 inline-block underline">Return to newest inquiries</Link>
  </section>;
  return <div className="space-y-6">
    <div><Link href="/dashboard" className="text-sm underline underline-offset-4">Back to dashboard</Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Collaboration inbox</h1>
      <p className="mt-2 text-muted-foreground">Review your collaboration requests. Newest first. All dates are UTC.</p></div>
    {result.items.length === 0 ? <section className="rounded-xl border bg-background p-8 text-center">
      <h2 className="text-xl font-semibold">No inquiries to show</h2>
      <p className="mt-3 text-muted-foreground">Received inquiries will appear here when available.</p>
    </section> : <ul className="divide-y rounded-xl border bg-background">
      {result.items.map(item => <li key={item.id}>
        <Link href={`/dashboard/inquiries/${item.id}`} prefetch={false} className="block rounded-lg p-6 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0"><h2 className="break-words text-lg font-semibold">{item.sender_name}</h2>
              {item.company && <p className="break-words text-sm text-muted-foreground">{item.company}</p>}</div>
            <time dateTime={item.created_at} className="shrink-0 text-xs text-muted-foreground">{inquiryDate(item.created_at)}</time>
          </div>
          <p className="mt-4 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.message_preview}</p>
          <span className="mt-4 inline-block text-sm underline underline-offset-4">Read inquiry</span>
        </Link>
      </li>)}
    </ul>}
    <nav aria-label="Inbox pagination" className="flex flex-wrap justify-between gap-4 text-sm">
      <Link href="/dashboard/inquiries" prefetch={false} className="underline underline-offset-4">Newest inquiries</Link>
      {result.nextCursor && <Link href={`/dashboard/inquiries?cursor=${result.nextCursor}`} prefetch={false} className="underline underline-offset-4">Older inquiries →</Link>}
    </nav>
  </div>;
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return <Suspense fallback={<Loading />}><Inbox searchParams={searchParams} /></Suspense>;
}
