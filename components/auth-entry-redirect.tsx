import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasEnvVars } from "@/lib/utils";

export async function AuthEntryRedirect() {
  if (!hasEnvVars) return null;
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (!error && data.user) redirect("/dashboard");
  return null;
}
