"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { saveOwnProfile, type ProfileState } from "@/lib/creator/profile";
import { setOwnPublication, type PublicationState } from "@/lib/creator/publication";

async function save(mode: "create" | "update", form: FormData): Promise<ProfileState> {
  const result = await saveOwnProfile(await createClient(), mode, form);
  if (result.success || result.destination === "/dashboard") {
    revalidatePath("/dashboard");
    revalidatePath("/onboarding");
  }
  if (result.destination) redirect(result.destination);
  return result;
}

export async function createProfile(_previous: ProfileState, form: FormData) {
  return save("create", form);
}

export async function updateProfile(_previous: ProfileState, form: FormData) {
  return save("update", form);
}

export async function updatePublication(_previous: PublicationState, form: FormData): Promise<PublicationState> {
  const result = await setOwnPublication(await createClient(), form);
  if (result.destination) redirect(result.destination);
  if (result.success) revalidatePath("/dashboard");
  return result;
}
