import type { SupabaseClient } from "@supabase/supabase-js";

// Keep in sync with the versioned creator_profiles constraints.
export const RESERVED_SLUGS = [
  "admin", "api", "app", "auth", "billing", "collabflow", "dashboard",
  "help", "login", "logout", "onboarding", "privacy", "protected",
  "settings", "signup", "support", "terms", "www",
] as const;

export type ProfileValues = { display_name: string; slug: string; bio: string };
export type CreatorProfile = ProfileValues & { user_id: string; is_public: boolean };
export type ProfileState = {
  values: ProfileValues;
  errors?: Partial<Record<keyof ProfileValues, string>>;
  message?: string;
  success?: boolean;
};
export type SaveResult = ProfileState & {
  destination?: "/auth/login" | "/dashboard" | "/onboarding";
};

export const emptyProfile: ProfileValues = { display_name: "", slug: "", bio: "" };

export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function validateProfile(form: FormData): ProfileState {
  const errors: NonNullable<ProfileState["errors"]> = {};
  const values = { ...emptyProfile };
  for (const key of Object.keys(values) as (keyof ProfileValues)[]) {
    const entries = form.getAll(key);
    const value = entries[0];
    if (entries.length > 1 || (value !== undefined && typeof value !== "string")) {
      errors[key] = "Enter a single text value.";
    } else {
      values[key] = typeof value === "string" ? value.trim() : "";
    }
  }
  values.slug = normalizeSlug(values.slug);
  const length = (value: string) => Array.from(value).length;
  // Reject control characters, including PostgreSQL's unsupported NUL.
  const hasControls = (value: string) => /\p{Cc}/u.test(value);
  if (!errors.display_name && (length(values.display_name) < 2 || length(values.display_name) > 60 || hasControls(values.display_name))) {
    errors.display_name = "Use 2–60 characters without control characters.";
  }
  if (!errors.slug) {
    if (values.slug.length < 3 || values.slug.length > 40 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.slug)) {
      errors.slug = "Use 3–40 letters or numbers, separated by single hyphens.";
    } else if ((RESERVED_SLUGS as readonly string[]).includes(values.slug)) {
      errors.slug = "This slug is reserved. Please choose another.";
    }
  }
  if (!errors.bio && (length(values.bio) > 280 || hasControls(values.bio))) {
    errors.bio = "Use up to 280 characters on a single line.";
  }
  return { values, ...(Object.keys(errors).length ? { errors } : {}) };
}

export async function readOwnProfile(client: SupabaseClient, userId: string) {
  return client.from("creator_profiles")
    .select("user_id, display_name, slug, bio, is_public")
    .eq("user_id", userId)
    .maybeSingle();
}

export async function getCreatorContext(client: SupabaseClient): Promise<
  | { status: "unauthenticated" }
  | { status: "error" }
  | { status: "ready"; profile: CreatorProfile | null }
> {
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return { status: "unauthenticated" };
    const result = await readOwnProfile(client, data.user.id);
    if (result.error) return { status: "error" };
    return {
      status: "ready",
      profile: result.data ? { ...result.data, bio: result.data.bio ?? "" } as CreatorProfile : null,
    };
  } catch {
    return { status: "error" };
  }
}

// The client is supplied by a server action using the existing cookie-scoped
// Supabase factory. No submitted owner ID or previous action state is trusted.
export async function saveOwnProfile(
  client: SupabaseClient,
  mode: "create" | "update",
  form: FormData,
): Promise<SaveResult> {
  const state = validateProfile(form);
  const failed = { ...state, message: "We couldn’t save your profile. Please try again." };
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return { ...state, destination: "/auth/login" };
    const userId = data.user.id;
    if (mode === "create") {
      const existing = await readOwnProfile(client, userId);
      if (existing.error) return failed;
      if (existing.data) return { ...state, destination: "/dashboard" };
    }
    if (state.errors) return state;

    const fields = { ...state.values, bio: state.values.bio || null };
    const table = client.from("creator_profiles");
    const result = mode === "create"
      ? await table.insert({ ...fields, user_id: userId }).select("user_id").maybeSingle()
      : await table.update(fields).eq("user_id", userId).select("user_id").maybeSingle();

    if (result.error?.code === "23505") {
      // Another tab may have created this user's profile since the first read.
      // Do not overwrite it or disclose another owner's database error details.
      if (mode === "create") {
        const existing = await readOwnProfile(client, userId);
        if (existing.error) return failed;
        if (existing.data) return { ...state, destination: "/dashboard" };
      }
      return { ...state, errors: { slug: "This slug is already taken. Please choose another." } };
    }
    if (result.error) return failed;
    if (!result.data) return { ...state, destination: "/onboarding" };
    return mode === "create"
      ? { ...state, destination: "/dashboard" }
      : { ...state, success: true, message: "Profile updated." };
  } catch {
    return failed;
  }
}
