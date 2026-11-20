import "server-only";
import postgres from "postgres";
import type { DbResult, InquiryStore, IntakeConfig } from "./intake";

export function inquiryConfig(): IntakeConfig {
  const list = (value: string | undefined) => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
  return {
    enabled: process.env.INQUIRIES_ENABLED === "true",
    origins: list(process.env.INQUIRY_ALLOWED_ORIGINS),
    hostnames: list(process.env.TURNSTILE_ALLOWED_HOSTNAMES),
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY ?? "",
    hmacSecret: process.env.INQUIRY_HMAC_SECRET ?? "",
    vercel: process.env.VERCEL === "1",
  };
}

let connection: ReturnType<typeof postgres> | undefined;
export function inquiryStore(): InquiryStore {
  if (!connection) {
    const url = process.env.INQUIRY_DATABASE_URL;
    if (!url) throw new Error("Inquiry configuration unavailable");
    const parsed = new URL(url);
    const username = decodeURIComponent(parsed.username);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.password ||
        !/^collabflow_inquiry_writer(?:\.[a-z0-9-]+)?$/.test(username) || parsed.search || parsed.hash) {
      throw new Error("Restricted inquiry connection required");
    }
    connection = postgres(url, {
      // Transaction pooling does not support prepared statements. Each warm
      // process keeps at most one connection; aggregate deployment concurrency
      // must still fit the pooler's capacity.
      prepare: false, max: 1, connect_timeout: 5, idle_timeout: 20, max_lifetime: 300,
      ssl: { rejectUnauthorized: true, ...(process.env.INQUIRY_DATABASE_CA ? { ca: process.env.INQUIRY_DATABASE_CA.replace(/\\n/g, "\n") } : {}) },
      onnotice: () => {},
    });
  }
  const sql = connection;
  return {
    async begin(a) {
      const rows = await sql`select collabflow_private.begin_inquiry_attempt(${a.ipHash}, ${a.emailHash}, ${a.creatorId}::uuid, ${a.submissionId}::uuid, ${a.fingerprint}) as result`;
      return rows[0].result as DbResult;
    },
    async finish(ticket, input, tokenHash) {
      const rows = await sql`select collabflow_private.finish_inquiry(${ticket}::uuid, ${input.creatorSlug}, ${tokenHash}, ${input.senderName}, ${input.senderEmail}, ${input.company}, ${input.message}) as result`;
      return rows[0].result as DbResult;
    },
  };
}
