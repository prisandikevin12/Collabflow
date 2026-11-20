// Browser-only data: never import the Node/secret-bearing intake modules here.
export const TURNSTILE_ACTION = "collaboration_inquiry";
export type InquiryFields = {
  senderName: string; senderEmail: string; company: string; message: string; website: string;
};
export type SubmissionSnapshot = {
  id: string;
  fingerprint: string;
};

// Keep the id for retries (including lost responses); an edited payload needs a
// fresh id and a fresh challenge. No form contents are persisted in storage.
export function submissionSnapshot(
  previous: SubmissionSnapshot | null,
  creatorPublicId: string,
  creatorSlug: string,
  fields: InquiryFields,
  makeId: () => string = () => crypto.randomUUID(),
): SubmissionSnapshot {
  const fingerprint = JSON.stringify([creatorPublicId, creatorSlug, fields.senderName,
    fields.senderEmail, fields.company, fields.message, fields.website]);
  return previous?.fingerprint === fingerprint ? previous : { id: makeId(), fingerprint };
}

export function inquiryFeedback(status: number): string {
  const messages: Record<number, string> = {
    400: "Check your details and try again. Use a valid email and a message of 10–5,000 characters.",
    403: "Verification expired or failed. Complete a new verification and try again.",
    404: "This creator is not accepting inquiries right now.",
    409: "Your submission changed. Prepare a new verification and try again.",
    413: "Your message is too large. Please shorten it and try again.",
    429: "Too many attempts. Please wait before trying again; limits can last up to 24 hours.",
  };
  return messages[status] ?? "We could not confirm receipt. Your details are kept here; retry to check or submit safely.";
}

export function acceptedReceipt(status: number, body: unknown): string | null {
  if (status !== 200 || !body || typeof body !== "object" || !("receipt" in body)) return null;
  return typeof body.receipt === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.receipt)
    ? body.receipt : null;
}
