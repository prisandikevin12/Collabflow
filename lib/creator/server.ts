import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCreatorContext } from "@/lib/creator/profile";
import { getCreatorRedirect } from "@/lib/auth/policy";

export async function requireCreatorContext(pathname: "/dashboard" | "/onboarding" | "/protected") {
  const context = await getCreatorContext(await createClient());
  if (context.status === "unauthenticated") redirect("/auth/login");
  // A database failure must not look like an absent profile or cause a loop.
  if (context.status === "error") throw new Error("Unable to load creator profile.");
  const destination = getCreatorRedirect(pathname, context.profile !== null);
  if (destination) redirect(destination);
  return context;
}
