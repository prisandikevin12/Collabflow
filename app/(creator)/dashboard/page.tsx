import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Inbox, Link2 } from "lucide-react";
import { CreatorProfileForm } from "@/components/creator-profile-form";
import { requireCreatorContext } from "@/lib/creator/server";
import Loading from "../loading";

export const metadata: Metadata = { title: "Dashboard | CollabFlow" };

async function Dashboard() {
  const { profile } = await requireCreatorContext("/dashboard");
  if (!profile) redirect("/onboarding");
  return (
    <div className="space-y-8">
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Creator workspace</p>
        <h1 className="break-words text-3xl font-semibold tracking-tight sm:text-4xl">Welcome, {profile.display_name}</h1>
        <p className="mt-3 text-muted-foreground">Your profile and future collaborations, in one place.</p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-6">
          <section aria-labelledby="link-heading" className="rounded-xl border bg-background p-6 sm:p-8">
            <div className="flex items-center gap-3"><Link2 size={18} aria-hidden="true" /><h2 id="link-heading" className="font-semibold">Your collaboration URL</h2></div>
            <p className="mt-5 break-all rounded-lg bg-muted px-4 py-3 font-mono text-sm">/c/{profile.slug}</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Planned URL on this site. Public pages aren’t available yet; this link is not live.</p>
          </section>
          <section aria-labelledby="inquiries-heading" className="rounded-xl border bg-background p-6 sm:p-8">
            <div className="flex items-center justify-between gap-4"><h2 id="inquiries-heading" className="font-semibold">Collaboration inquiries</h2><span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">Coming later</span></div>
            <div className="flex flex-col items-center py-12 text-center">
              <div className="mb-5 rounded-full bg-muted p-4"><Inbox size={24} className="text-muted-foreground" aria-hidden="true" /></div>
              <h3 className="font-medium">No inquiries yet</h3>
              <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">Once inquiries are available, you’ll be able to review collaboration requests here.</p>
            </div>
          </section>
        </div>
        <section aria-labelledby="edit-heading" className="min-w-0 rounded-xl border bg-background p-6 shadow-sm sm:p-8">
          <h2 id="edit-heading" className="text-xl font-semibold">Profile details</h2>
          <p className="mb-7 mt-2 text-sm text-muted-foreground">Keep your creator details up to date.</p>
          <CreatorProfileForm mode="update" profile={profile} />
        </section>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Dashboard /></Suspense>;
}
