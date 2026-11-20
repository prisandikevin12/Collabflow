import type { SupabaseClient } from "@supabase/supabase-js";

export const INBOX_PAGE_SIZE = 20;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Cursor = { created_at: string; id: string };
export type InquiryPreview = Cursor & { sender_name: string; company: string | null; message_preview: string };
export type InquiryDetail = Cursor & { sender_name: string; sender_email: string; company: string | null; message: string };
type Failure = { status: "unauthenticated" | "onboarding" | "error" | "invalid" | "not-found" };
export type InboxResult = Failure | { status: "ready"; items: InquiryPreview[]; nextCursor: string | null };
export type InquiryResult = Failure | { status: "ready"; inquiry: InquiryDetail };

function validTimestamp(value: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts || parts[0] !== value) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Validate the written calendar date, not Date.parse's normalized result.
  // PostgreSQL numeric timezone displacements must be less than 16 hours.
  // Never round-trip through Date: retain the offset and all six fractional digits.
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (offsetHour === undefined || (Number(offsetHour) <= 15 && Number(offsetMinute) <= 59));
}

function validCursor(value: unknown): value is Cursor {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === "string" && uuid.test(c.id) && typeof c.created_at === "string"
    && validTimestamp(c.created_at);
}

export function parseInboxCursor(value: string): Cursor | null {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!validCursor(decoded) || Object.keys(decoded).sort().join(",") !== "created_at,id") return null;
    return decoded;
  } catch { return null; }
}

async function access(client: SupabaseClient): Promise<Failure | null> {
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return { status: "unauthenticated" };
    const profile = await client.from("creator_profiles").select("user_id").eq("user_id", data.user.id).maybeSingle();
    if (profile.error) return { status: "error" };
    return profile.data ? null : { status: "onboarding" };
  } catch { return { status: "error" }; }
}

function preview(value: unknown): InquiryPreview | null {
  if (!validCursor(value)) return null;
  const row = value as Cursor & Record<string, unknown>;
  if (typeof row.sender_name !== "string" || typeof row.message_preview !== "string"
    || (row.company !== null && typeof row.company !== "string")) return null;
  // Project fields explicitly: never serialize unexpected DB columns.
  return { id: row.id, created_at: row.created_at, sender_name: row.sender_name,
    company: row.company, message_preview: row.message_preview };
}

export async function readInbox(client: SupabaseClient, params: Record<string, string | string[] | undefined>): Promise<InboxResult> {
  const denied = await access(client);
  if (denied) return denied;
  if (Object.keys(params).some(key => key !== "cursor") || Array.isArray(params.cursor)) return { status: "invalid" };
  const cursor = params.cursor === undefined ? null : parseInboxCursor(params.cursor);
  if (params.cursor !== undefined && !cursor) return { status: "invalid" };
  try {
    const { data, error } = await client.rpc("list_creator_inquiries", {
      p_before_created_at: cursor?.created_at ?? null, p_before_id: cursor?.id ?? null, p_limit: INBOX_PAGE_SIZE + 1,
    });
    if (error) return { status: error.code === "PGRST301" || error.code === "PGRST303" ? "unauthenticated" : "error" };
    if (!Array.isArray(data) || data.length > INBOX_PAGE_SIZE + 1) return { status: "error" };
    const rows = data.map(preview);
    if (rows.some(row => row === null)) return { status: "error" };
    const items = (rows as InquiryPreview[]).slice(0, INBOX_PAGE_SIZE);
    const last = items.at(-1);
    // Preserve PostgreSQL microseconds; Date.toISOString() would lose precision.
    const nextCursor = rows.length > INBOX_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url") : null;
    return { status: "ready", items, nextCursor };
  } catch { return { status: "error" }; }
}

export async function readInquiry(client: SupabaseClient, id: string): Promise<InquiryResult> {
  const denied = await access(client);
  if (denied) return denied;
  if (!uuid.test(id)) return { status: "not-found" };
  try {
    const { data, error } = await client.rpc("get_creator_inquiry", { p_inquiry_id: id });
    if (error) return { status: error.code === "PGRST301" || error.code === "PGRST303" ? "unauthenticated" : "error" };
    if (!Array.isArray(data) || data.length > 1) return { status: "error" };
    if (!data.length) return { status: "not-found" };
    if (!validCursor(data[0])) return { status: "error" };
    const row = data[0] as Cursor & Record<string, unknown>;
    if (typeof row.sender_name !== "string" || typeof row.sender_email !== "string"
      || typeof row.message !== "string" || (row.company !== null && typeof row.company !== "string")) return { status: "error" };
    return { status: "ready", inquiry: { id: row.id, created_at: row.created_at, sender_name: row.sender_name,
      sender_email: row.sender_email, company: row.company, message: row.message } };
  } catch { return { status: "error" }; }
}

export function inquiryDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(timestamp)) + " UTC";
}
