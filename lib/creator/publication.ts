import type { SupabaseClient } from "@supabase/supabase-js";

export type PublicationState = {
  success?: boolean;
  isPublic?: boolean;
  message?: string;
  destination?: "/auth/login" | "/onboarding";
};

export async function setOwnPublication(client: SupabaseClient, form: FormData): Promise<PublicationState> {
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return { destination: "/auth/login" };
    const values = form.getAll("is_public");
    if (values.length !== 1 || !["true", "false"].includes(String(values[0]))) {
      return { message: "Choose whether to publish or unpublish your profile." };
    }
    const isPublic = values[0] === "true";
    const result = await client.from("creator_profiles")
      .update({ is_public: isPublic }).eq("user_id", data.user.id)
      .select("is_public").maybeSingle();
    if (result.error) return { message: "We couldn’t change publication. Please try again." };
    if (!result.data) return { destination: "/onboarding" };
    return {
      success: true, isPublic: result.data.is_public,
      message: result.data.is_public ? "Your profile is now public." : "Your profile is now private.",
    };
  } catch {
    return { message: "We couldn’t change publication. Please try again." };
  }
}
