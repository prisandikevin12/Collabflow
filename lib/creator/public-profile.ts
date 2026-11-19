import type { SupabaseClient } from "@supabase/supabase-js";

export type PublicCreatorProfile = {
  public_id: string;
  slug: string;
  display_name: string;
  bio: string | null;
};

export function isCanonicalCreatorSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

export async function readPublicCreator(client: SupabaseClient, slug: string): Promise<
  | { status: "found"; profile: PublicCreatorProfile }
  | { status: "not-found" }
  | { status: "unavailable" }
> {
  if (!isCanonicalCreatorSlug(slug)) return { status: "not-found" };
  try {
    const { data, error } = await client.from("creator_public_profiles")
      .select("public_id, slug, display_name, bio").eq("slug", slug).maybeSingle();
    if (error) return { status: "unavailable" };
    if (!data) return { status: "not-found" };
    // Explicit serialization is a second boundary against accidental private fields.
    return { status: "found", profile: {
      public_id: data.public_id, slug: data.slug,
      display_name: data.display_name, bio: data.bio,
    } };
  } catch {
    return { status: "unavailable" };
  }
}
