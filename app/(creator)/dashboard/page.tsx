import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Inbox, Link2 } from "lucide-react";
import { CreatorProfileForm } from "@/components/creator-profile-form";
import { ProfilePublicationForm } from "@/components/profile-publication-form";
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
            <div className="mt-5 break-all rounded-lg bg-muted px-4 py-3 font-mono text-sm">
              {profile.is_public
                ? <a href={`/c/${profile.slug}`} className="underline underline-offset-4">/c/{profile.slug}</a>
                : <span>/c/{profile.slug}</span>}
            </div>
            <p className="mt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {profile.is_public ? "Published · Link is live" : "Private · Link is not live"}
            </p>
            <ProfilePublicationForm isPublic={profile.is_public} />
          </section>
          <section aria-labelledby="inquiries-heading" className="rounded-xl border bg-background p-6 sm:p-8">
            <h2 id="inquiries-heading" className="font-semibold">Collaboration inquiries</h2>
            <div className="flex flex-col items-center py-12 text-center">
              <div className="mb-5 rounded-full bg-muted p-4"><Inbox size={24} className="text-muted-foreground" aria-hidden="true" /></div>
              <h3 className="font-medium">Your creator inbox</h3>
              <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">Read collaboration proposals and sender contact details in your private inbox.</p>
              <Link href="/dashboard/inquiries" prefetch={false} className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Open inbox</Link>
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
