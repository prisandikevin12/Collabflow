import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { Suspense } from "react";
import { decodePublicProfile, PUBLIC_PROFILE_HEADER } from "@/lib/creator/public-request";
import { InquiryForm } from "@/components/inquiry-form";

export const metadata: Metadata = { title: "Creator profile | CollabFlow" };

async function PublicProfile({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const profile = decodePublicProfile((await headers()).get(PUBLIC_PROFILE_HEADER), slug);
  if (!profile) notFound();
  return (
    <div className="min-h-svh bg-muted/30">
      <header className="border-b bg-background">
        <nav aria-label="Main navigation" className="mx-auto max-w-5xl px-5 py-5 sm:px-8">
          <Link href="/" className="text-xl font-semibold tracking-tight">CollabFlow.</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-20">
        <article className="rounded-xl border bg-background p-6 shadow-sm sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Creator profile</p>
          <h1 className="mt-5 break-words text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">{profile.display_name}</h1>
          <p className="mt-3 break-all text-sm text-muted-foreground">@{profile.slug}</p>
          {profile.bio && <p className="mt-8 whitespace-pre-wrap break-words text-base leading-relaxed">{profile.bio}</p>}
        </article>
        {process.env.INQUIRIES_ENABLED === "true" && process.env.TURNSTILE_SITE_KEY
          ? <InquiryForm key={profile.public_id} creatorPublicId={profile.public_id} creatorSlug={profile.slug} siteKey={process.env.TURNSTILE_SITE_KEY} />
          : <p className="mt-6 text-sm text-muted-foreground">Collaboration inquiries aren’t available yet.</p>}
      </main>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <Suspense fallback={<main className="mx-auto max-w-3xl px-6 py-16" aria-busy="true">Loading creator profile…</main>}>
    <PublicProfile params={params} />
  </Suspense>;
}
