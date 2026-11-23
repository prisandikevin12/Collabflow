import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { acceptedReceipt, inquiryFeedback, submissionSnapshot, TURNSTILE_ACTION } from "../lib/inquiries/client.ts";
import { INQUIRY_ACTION } from "../lib/inquiries/intake.ts";

test("client and server use the same Turnstile action", () => assert.equal(TURNSTILE_ACTION, INQUIRY_ACTION));
test("unchanged payload retains id across retries; edits or creator changes require a new id", () => {
  let count = 0;
  const makeId = () => String(++count);
  const fields = { senderName: "Alice", senderEmail: "a@example.test", company: "", message: "A proposal.", website: "" };
  const first = submissionSnapshot(null, "creator-a", "slug-a", fields, makeId);
  assert.strictEqual(submissionSnapshot(first, "creator-a", "slug-a", { ...fields }, makeId), first);
  for (const name of Object.keys(fields)) {
    assert.notEqual(submissionSnapshot(first, "creator-a", "slug-a", { ...fields, [name]: "changed" }, makeId).id, first.id);
  }
  assert.notEqual(submissionSnapshot(first, "creator-b", "slug-a", fields, makeId).id, first.id);
  assert.notEqual(submissionSnapshot(first, "creator-a", "slug-b", fields, makeId).id, first.id);
});
test("success requires a valid receipt and HTTP 200", () => {
  const receipt = "88888888-8888-4888-8888-888888888888";
  assert.equal(acceptedReceipt(200, { receipt }), receipt);
  for (const body of [null, {}, "success", { receipt: "<script>" }]) assert.equal(acceptedReceipt(200, body), null);
  assert.equal(acceptedReceipt(503, { receipt }), null);
  assert.match(inquiryFeedback(503), /could not confirm receipt/);
  assert.match(inquiryFeedback(429), /24 hours/);
});

test("inquiry form disclosure accurately states collected data, 180-day scheduled cleanup, and avoids unpublished policy links", () => {
  const form = readFileSync(new URL("../components/inquiry-form.tsx", import.meta.url), "utf8");
  assert.match(form, /name, email address, optional company, and collaboration proposal/);
  assert.match(form, /available to the intended creator for reviewing your proposal/);
  assert.match(form, /180-day retention policy/);
  assert.match(form, /scheduled cleanup after the 180-day retention deadline and may not occur at exactly 180 days/);
  assert.match(form, /Cloudflare Turnstile/);
  assert.doesNotMatch(form, /backup retention policy|privacy policy/i);
  assert.doesNotMatch(form, /href=|<a\b|<Link\b/);
});
