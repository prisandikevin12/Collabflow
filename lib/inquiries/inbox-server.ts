import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readInbox, readInquiry } from "./inbox";

// A fresh cookie-scoped client on every request. No writer connection, service
// key, use-cache directive, or shared client/result cache is used for reads.
export async function loadInbox(params: Record<string, string | string[] | undefined>) {
  return readInbox(await createClient(), params);
}

export async function loadInquiry(id: string) {
  return readInquiry(await createClient(), id);
}
