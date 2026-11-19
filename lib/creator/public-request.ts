import type { PublicCreatorProfile } from "./public-profile";

// Written by the proxy, never trusted from the browser. Carries only the four
// public fields so rendering uses the same snapshot as the HTTP status check.
export const PUBLIC_PROFILE_HEADER = "x-collabflow-public-profile";

export function encodePublicProfile(profile: PublicCreatorProfile): string {
  return encodeURIComponent(JSON.stringify({
    public_id: profile.public_id, slug: profile.slug,
    display_name: profile.display_name, bio: profile.bio,
  }));
}

export function decodePublicProfile(value: string | null, slug: string): PublicCreatorProfile | null {
  if (!value) return null;
  try {
    const profile = JSON.parse(decodeURIComponent(value));
    if (!profile || typeof profile.public_id !== "string" || profile.slug !== slug ||
        typeof profile.display_name !== "string" ||
        !(profile.bio === null || typeof profile.bio === "string")) return null;
    return { public_id: profile.public_id, slug: profile.slug, display_name: profile.display_name, bio: profile.bio };
  } catch {
    return null;
  }
}
