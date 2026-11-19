import type { Metadata } from "next";
import { Suspense } from "react";
import { CreatorProfileForm } from "@/components/creator-profile-form";
import { requireCreatorContext } from "@/lib/creator/server";
import Loading from "../loading";

export const metadata: Metadata = { title: "Create your profile | CollabFlow" };

async function Onboarding() {
  await requireCreatorContext("/onboarding");
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-20">
      <div className="lg:pt-8">
        <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Welcome to CollabFlow</p>
        <h1 className="max-w-sm text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Set up your creator profile.</h1>
        <p className="mt-6 max-w-sm text-base leading-relaxed text-muted-foreground">Start with your creator profile. Choose a name and a unique slug for your workspace.</p>
        <div className="mt-8 border-l-2 border-foreground/20 pl-4 text-sm leading-relaxed text-muted-foreground">
          You can edit these details later. Your profile is private while public collaboration pages are being built.
        </div>
      </div>
      <section aria-labelledby="profile-heading" className="rounded-xl border bg-background p-6 shadow-sm sm:p-8">
        <h2 id="profile-heading" className="text-xl font-semibold">Your creator profile</h2>
        <p className="mb-8 mt-2 text-sm text-muted-foreground">A few details to get started.</p>
        <CreatorProfileForm mode="create" />
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Onboarding /></Suspense>;
}
