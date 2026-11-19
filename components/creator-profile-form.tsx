"use client";

import { useActionState } from "react";
import { createProfile, updateProfile } from "@/app/(creator)/actions";
import { emptyProfile, type ProfileValues } from "@/lib/creator/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreatorProfileForm({ mode, profile = emptyProfile }: {
  mode: "create" | "update";
  profile?: ProfileValues;
}) {
  const [state, action, pending] = useActionState(
    mode === "create" ? createProfile : updateProfile,
    { values: profile },
  );
  const fieldError = (field: keyof ProfileValues) => state.errors?.[field] ? (
    <p id={`${field}-error`} className="text-sm text-destructive">{state.errors[field]}</p>
  ) : null;

  return (
    <form action={action} aria-busy={pending} className="space-y-6">
      <fieldset disabled={pending} className="min-w-0 space-y-6">
        <legend className="sr-only">Creator profile</legend>
        <div className="space-y-2">
          <Label htmlFor="display_name">Display name</Label>
          <Input id="display_name" name="display_name" autoComplete="nickname" required
            defaultValue={state.values.display_name} aria-invalid={!!state.errors?.display_name}
            aria-describedby="display_name-help display_name-error" placeholder="Your name or studio" />
          <p id="display_name-help" className="text-xs text-muted-foreground">The name you use for your creative work. 2–60 characters.</p>
          {fieldError("display_name")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">Creator slug</Label>
          <div className="flex items-center rounded-md border focus-within:ring-1 focus-within:ring-ring">
            <span className="pl-3 text-sm text-muted-foreground" aria-hidden="true">/c/</span>
            <Input id="slug" name="slug" required minLength={3} maxLength={40}
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              className="border-0 shadow-none focus-visible:ring-0"
              defaultValue={state.values.slug} aria-invalid={!!state.errors?.slug}
              aria-describedby="slug-help slug-error" placeholder="your-name" />
          </div>
          <p id="slug-help" className="text-xs leading-relaxed text-muted-foreground">
            3–40 letters or numbers with single hyphens. Saved in lowercase.
            This will be part of your collaboration URL.
          </p>
          {fieldError("slug")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="bio">Short bio <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="bio" name="bio" defaultValue={state.values.bio}
            aria-invalid={!!state.errors?.bio} aria-describedby="bio-help bio-error"
            placeholder="What do you create?" />
          <p id="bio-help" className="text-xs text-muted-foreground">Up to 280 characters on a single line.</p>
          {fieldError("bio")}
        </div>
      </fieldset>
      <div aria-live="polite" aria-atomic="true">
        {state.errors && <p role="alert" className="text-sm text-destructive">Please check the highlighted fields.</p>}
        {state.message && <p role={state.success ? "status" : "alert"}
          className={state.success ? "text-sm text-foreground" : "text-sm text-destructive"}>{state.message}</p>}
      </div>
      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Saving profile…" : mode === "create" ? "Create profile" : "Save changes"}
      </Button>
    </form>
  );
}
