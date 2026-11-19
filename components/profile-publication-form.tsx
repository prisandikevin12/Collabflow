"use client";

import { useActionState } from "react";
import { updatePublication } from "@/app/(creator)/actions";
import type { PublicationState } from "@/lib/creator/publication";
import { Button } from "@/components/ui/button";

export function ProfilePublicationForm({ isPublic }: { isPublic: boolean }) {
  const [state, action, pending] = useActionState<PublicationState, FormData>(updatePublication, {});
  return (
    <form action={action} aria-busy={pending} className="mt-5 space-y-4">
      <p id="publication-help" className="text-sm leading-relaxed text-muted-foreground">
        {isPublic
          ? "Anyone with your link can see your name, slug, and bio. Unpublishing removes your public page."
          : "Your profile is private. Publishing makes your name, slug, and bio visible to anyone on the web."}
        {" "}Your account email stays private.
      </p>
      <input type="hidden" name="is_public" value={isPublic ? "false" : "true"} />
      <Button type="submit" variant={isPublic ? "outline" : "default"} disabled={pending}
        aria-describedby="publication-help" className="w-full sm:w-auto">
        {pending ? "Saving…" : isPublic ? "Unpublish profile" : "Publish profile"}
      </Button>
      <div aria-live="polite" aria-atomic="true">
        {state.message && <p role={state.success ? "status" : "alert"}
          className={state.success ? "text-sm" : "text-sm text-destructive"}>{state.message}</p>}
      </div>
    </form>
  );
}
