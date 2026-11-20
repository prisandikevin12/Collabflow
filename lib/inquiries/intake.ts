import { createHash, createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export const INQUIRY_ACTION = "collaboration_inquiry";
export const MAX_BODY_BYTES = 32768;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const messageControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

export type InquiryInput = {
  creatorPublicId: string; creatorSlug: string; submissionId: string;
  senderName: string; senderEmail: string; company: string; message: string;
  website: string; turnstileToken: string;
};
export type IntakeConfig = {
  enabled: boolean; origins: string[]; hostnames: string[];
  turnstileSecret: string; hmacSecret: string; vercel: boolean;
};
export type DbResult = { status: string; ticket?: string; receipt?: string };
export type Attempt = { ipHash: string; emailHash: string; fingerprint: string; creatorId: string; submissionId: string };
export type InquiryStore = {
  begin(attempt: Attempt): Promise<DbResult>;
  finish(ticket: string, input: InquiryInput, tokenHash: string): Promise<DbResult>;
};
export class IntakeError extends Error {
  status: number;
  constructor(status: number) { super("Inquiry request rejected"); this.status = status; }
}

function cleanText(value: unknown, min: number, max: number, multiline = false): string {
  if (typeof value !== "string" || /[\ud800-\udfff]/u.test(value)) throw new IntakeError(400);
  const text = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if ((multiline ? messageControls : controls).test(text) || [...text].length < min || [...text].length > max) throw new IntakeError(400);
  return text;
}

export function validateInquiry(value: unknown): InquiryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntakeError(400);
  const data = value as Record<string, unknown>;
  const allowed = ["creatorPublicId", "creatorSlug", "submissionId", "senderName", "senderEmail", "company", "message", "website", "turnstileToken"];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new IntakeError(400);
  for (const key of ["creatorPublicId", "submissionId"]) if (typeof data[key] !== "string" || !uuid.test(data[key])) throw new IntakeError(400);
  if (typeof data.creatorSlug !== "string" || data.creatorSlug.length < 3 || data.creatorSlug.length > 40 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.creatorSlug)) throw new IntakeError(400);
  const senderEmail = cleanText(data.senderEmail, 3, 254).toLowerCase();
  if (Buffer.byteLength(senderEmail) > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) throw new IntakeError(400);
  if (typeof data.turnstileToken !== "string" || data.turnstileToken.length < 1 || data.turnstileToken.length > 2048 || /\s/.test(data.turnstileToken)) throw new IntakeError(400);
  return {
    creatorPublicId: (data.creatorPublicId as string).toLowerCase(), creatorSlug: data.creatorSlug,
    submissionId: (data.submissionId as string).toLowerCase(),
    senderName: cleanText(data.senderName, 1, 100), senderEmail,
    company: cleanText(data.company ?? "", 0, 120), message: cleanText(data.message, 10, 5000, true),
    website: cleanText(data.website ?? "", 0, 200), turnstileToken: data.turnstileToken,
  };
}

export async function readInquiryBody(request: Request, timeoutMs = 5000): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new IntakeError(415);
  if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") throw new IntakeError(415);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new IntakeError(413);
  if (!request.body) throw new IntakeError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  // A declared Content-Length is never used as the actual size guarantee.
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new IntakeError(413); }
      chunks.push(value);
    }
    if (timedOut) throw new IntakeError(400);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new IntakeError(400); }
  } catch (error) {
    throw error instanceof IntakeError ? error : new IntakeError(400);
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}

// This contract is valid only behind Vercel's own ingress, which overwrites
// x-vercel-forwarded-for. No fallback to user-controlled forwarding headers.
export function trustedClientAddress(request: Request, vercel: boolean): string {
  const ip = vercel ? request.headers.get("x-vercel-forwarded-for") : null;
  if (!ip || isIP(ip) === 0) throw new IntakeError(503);
  return ip;
}

export function addressBucket(ip: string): string {
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) throw new IntakeError(503);
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const words = right !== undefined ? [...start, ...Array(8 - start.length - end.length).fill("0"), ...end] : start;
  const numbers = words.map(word => Number.parseInt(word, 16));
  if (numbers.slice(0, 5).every(word => word === 0) && numbers[5] === 65535) {
    return [numbers[6] >> 8, numbers[6] & 255, numbers[7] >> 8, numbers[7] & 255].join(".");
  }
  return `${numbers.slice(0, 4).map(word => word.toString(16)).join(":")}::/64`;
}

export function inquiryDigest(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("hex");
}

export async function verifyTurnstile(input: InquiryInput, config: IntakeConfig, fetcher: typeof fetch = fetch): Promise<boolean> {
  let response: Response;
  try {
    response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ secret: config.turnstileSecret, response: input.turnstileToken, idempotency_key: randomUUID() }),
    });
  } catch { throw new IntakeError(503); }
  if (!response.ok) throw new IntakeError(503);
  let data;
  try { data = await response.json(); } catch { throw new IntakeError(503); }
  if (!data || typeof data.success !== "boolean") throw new IntakeError(503);
  if (!data.success && Array.isArray(data["error-codes"]) &&
      data["error-codes"].some((code: unknown) => ["internal-error", "missing-input-secret", "invalid-input-secret"].includes(String(code)))) {
    throw new IntakeError(503);
  }
  return data.success === true && config.hostnames.includes(data.hostname) && data.action === INQUIRY_ACTION
    && data.cdata === `${input.creatorPublicId}_${input.submissionId}`;
}

export function intakeResponse(status: number, receipt?: string): Response {
  const messages: Record<number, string> = {
    200: "Your inquiry has been received.", 400: "Check your form and try again.",
    403: "Verification failed. Please try again.", 404: "Inquiries are unavailable for this profile.",
    409: "This submission has changed. Start a new inquiry.", 413: "Your submission is too large.",
    415: "Unsupported submission format.", 429: "Too many attempts. Please try again later.",
    503: "Inquiries are temporarily unavailable. Please try again later.",
  };
  return Response.json({ message: messages[status] ?? messages[503], ...(receipt ? { receipt } : {}) }, {
    // A denial may come from the daily creator/email/global quota.
    status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...(status === 429 ? { "Retry-After": "86400" } : {}) },
  });
}

function databaseResponse(result: DbResult): Response {
  if (result.status === "accepted" && result.receipt && uuid.test(result.receipt)) return intakeResponse(200, result.receipt);
  const status = { throttled: 429, conflict: 409, "not-found": 404, replay: 403, expired: 403, invalid: 400 }[result.status];
  return intakeResponse(status ?? 503);
}

export async function handleInquiry(request: Request, config: IntakeConfig, store: () => InquiryStore, verify = verifyTurnstile): Promise<Response> {
  if (!config.enabled) return intakeResponse(404);
  try {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    if (!config.origins.length || !config.hostnames.length || !config.turnstileSecret || config.hmacSecret.length < 32) throw new IntakeError(503);
    const origin = request.headers.get("origin");
    if (!origin || !config.origins.includes(origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new IntakeError(403);
    const ip = trustedClientAddress(request, config.vercel);
    const input = validateInquiry(await readInquiryBody(request));
    // Cheap decoys are rejected before any external call or durable allocation.
    if (input.website) return intakeResponse(400);
    const digest = (purpose: string, text: string) => inquiryDigest(config.hmacSecret, purpose, text);
    const db = store();
    const attempt = await db.begin({
      ipHash: digest("ip", addressBucket(ip)), emailHash: digest("email", input.senderEmail),
      creatorId: input.creatorPublicId, submissionId: input.submissionId,
      fingerprint: digest("payload", JSON.stringify([input.creatorPublicId, input.creatorSlug, input.senderName, input.senderEmail, input.company, input.message])),
    });
    if (attempt.status !== "ready") return databaseResponse(attempt);
    if (!attempt.ticket || !uuid.test(attempt.ticket)) throw new IntakeError(503);
    if (!await verify(input, config)) return intakeResponse(403);
    return databaseResponse(await db.finish(attempt.ticket, input, createHash("sha256").update(input.turnstileToken).digest("hex")));
  } catch (error) {
    // Deliberately never serialize upstream errors, submitted PII, or secrets.
    return intakeResponse(error instanceof IntakeError ? error.status : 503);
  }
}
