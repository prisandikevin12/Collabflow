import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { loadInquiry } from "@/lib/inquiries/inbox-server";
import { inquiryDate } from "@/lib/inquiries/inbox";
import Loading from "../loading";

export const metadata: Metadata = { title: "Inquiry | CollabFlow", robots: { index: false, follow: false } };

async function Inquiry({ params }: { params: Promise<{ id: string }> }) {
  const result = await loadInquiry((await params).id);
  if (result.status === "unauthenticated") redirect("/auth/login");
  if (result.status === "onboarding") redirect("/onboarding");
  if (result.status === "error") throw new Error("Unable to load inquiry.");
  if (result.status !== "ready") notFound();
  const { inquiry } = result;
  return <div className="space-y-6">
    <Link href="/dashboard/inquiries" prefetch={false} className="text-sm underline underline-offset-4">Back to inbox</Link>
    <article className="rounded-xl border bg-background p-6 sm:p-8">
      <h1 className="break-words text-2xl font-semibold sm:text-3xl">Inquiry from {inquiry.sender_name}</h1>
      <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Email</dt><dd className="mt-1 break-all">{inquiry.sender_email}</dd></div>
        {inquiry.company && <div><dt className="text-muted-foreground">Company</dt><dd className="mt-1 break-words">{inquiry.company}</dd></div>}
        <div><dt className="text-muted-foreground">Received</dt><dd className="mt-1"><time dateTime={inquiry.created_at}>{inquiryDate(inquiry.created_at)}</time></dd></div>
      </dl>
      <h2 className="mt-8 border-t pt-6 font-semibold">Proposal</h2>
      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed sm:text-base">{inquiry.message}</p>
    </article>
  </div>;
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<Loading />}><Inquiry params={params} /></Suspense>;
}
