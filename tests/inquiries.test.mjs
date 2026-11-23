import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { addressBucket, handleInquiry, inquiryDigest, IntakeError, MAX_BODY_BYTES,
  readInquiryBody, trustedClientAddress, validateInquiry, verifyTurnstile } from "../lib/inquiries/intake.ts";

const creatorPublicId = "55555555-5555-4555-8555-555555555555";
const submissionId = "66666666-6666-4666-8666-666666666666";
const ticket = "77777777-7777-4777-8777-777777777777";
const receipt = "88888888-8888-4888-8888-888888888888";
const config = { enabled: true, origins: ["https://collabflow.example"], hostnames: ["collabflow.example"],
  turnstileSecret: "fixture-secret", hmacSecret: "test-secret-".repeat(4), vercel: true };
const input = { creatorPublicId, creatorSlug: "public-creator", submissionId,
  senderName: "Alice", senderEmail: "alice@example.test", company: "", message: "A collaboration proposal.", website: "", turnstileToken: "fixture-token" };
const request = (body = input, headers = {}, method = "POST") => new Request("https://collabflow.example/api/inquiries", {
  method, headers: { "content-type": "application/json", origin: config.origins[0], "x-vercel-forwarded-for": "203.0.113.1", ...headers },
  ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});
function dependencies({ begin = { status: "ready", ticket }, finish = { status: "accepted", receipt }, verified = true } = {}) {
  const calls = [];
  const store = () => ({
    begin: async a => { calls.push(["begin", a]); return begin; },
    finish: async (...args) => { calls.push(["finish", ...args]); return finish; },
  });
  const verify = async () => { calls.push(["verify"]); return verified; };
  return { calls, store, verify };
}

test("inquiry validation normalizes text/email, accepts Unicode, and never trusts ownership fields", () => {
  const actual = validateInquiry({ ...input, senderName: "  A\u0301lice 😀 ", senderEmail: " Alice@Example.Test ", message: "Line one\r\nLine two", company: undefined });
  assert.equal(actual.senderName, "Álice 😀");
  assert.equal(actual.senderEmail, "alice@example.test");
  assert.equal(actual.message, "Line one\nLine two");
  assert.equal(actual.company, "");
  assert.throws(() => validateInquiry({ ...input, owner_id: randomUUID() }), IntakeError);
});

for (const [field, values] of Object.entries({
  creatorPublicId: [null, "not-a-uuid"], creatorSlug: ["ab", "UPPER", "bad--slug", "a".repeat(41)],
  submissionId: ["", "11111111-1111-1111-1111-111111111111"],
  senderName: ["", " ", "x".repeat(101), "a\u0000b", "\ud800"],
  senderEmail: ["bad", "a@b", "a@b.test\r\nbcc:other@test", "x".repeat(255)],
  company: ["x".repeat(121)], message: ["short", "x".repeat(5001), "message\u0000bad"],
  turnstileToken: ["", "has space", "x".repeat(2049)],
})) test(`invalid ${field} rejected`, () => {
  for (const value of values) assert.throws(() => validateInquiry({ ...input, [field]: value }), error => error.status === 400);
});

test("body reader rejects declared and actual oversize bodies, malformed UTF-8, JSON, and encodings", async () => {
  const rejects = (req, status) => assert.rejects(readInquiryBody(req), error => error.status === status);
  await rejects(request(input, { "content-length": String(MAX_BODY_BYTES + 1) }), 413);
  await rejects(request(input, { "content-length": "-1" }), 413);
  await rejects(request({ message: "x".repeat(MAX_BODY_BYTES) }, { "content-length": "1" }), 413);
  await rejects(request(input, { "content-type": "text/plain" }), 415);
  await rejects(request(input, { "content-encoding": "gzip" }), 415);
  await rejects(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]) }), 400);
  await rejects(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), 400);
  assert.deepEqual(await readInquiryBody(request()), input);
});

test("body timeout cannot accept an unterminated stream containing valid JSON", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); }, cancel() { cancelled = true; } });
  const req = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" });
  await assert.rejects(readInquiryBody(req, 10), error => error.status === 400);
  assert.equal(cancelled, true);
});

test("only platform-confirmed Vercel addresses are accepted; fallback headers cannot spoof", () => {
  assert.equal(trustedClientAddress(request(), true), "203.0.113.1");
  assert.throws(() => trustedClientAddress(request(), false), error => error.status === 503);
  for (const ip of ["", "203.0.113.1, 1.1.1.1", "not-an-ip"]) {
    assert.throws(() => trustedClientAddress(request(input, { "x-vercel-forwarded-for": ip, "x-forwarded-for": "1.1.1.1" }), true), error => error.status === 503);
  }
});

test("IPv6 equivalent forms and addresses in one /64 share a bucket; IPv4-mapped forms match IPv4", () => {
  assert.equal(addressBucket("2001:db8::1"), addressBucket("2001:0db8:0:0:ffff:1:2:3"));
  assert.equal(addressBucket("::ffff:192.0.2.1"), addressBucket("192.0.2.1"));
  assert.notEqual(addressBucket("2001:db8:0:1::1"), addressBucket("2001:db8:0:2::1"));
  assert.equal(addressBucket("::"), "0:0:0:0::/64");
});

test("HMAC digests are stable, purpose-separated and secret-dependent", () => {
  const digest = inquiryDigest(config.hmacSecret, "ip", "203.0.113.1");
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, inquiryDigest(config.hmacSecret, "ip", "203.0.113.1"));
  assert.notEqual(digest, inquiryDigest(config.hmacSecret, "email", "203.0.113.1"));
  assert.notEqual(digest, inquiryDigest("different", "ip", "203.0.113.1"));
});

test("Turnstile validates success, action, hostname and submission binding", async () => {
  const success = { success: true, hostname: config.hostnames[0], action: "collaboration_inquiry", cdata: `${creatorPublicId}_${submissionId}` };
  const fetcher = data => async (url, options) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.secret, config.turnstileSecret); assert.equal(body.response, input.turnstileToken);
    assert.ok(!options.body.includes(input.senderEmail));
    return Response.json(data);
  };
  assert.equal(await verifyTurnstile(input, config, fetcher(success)), true);
  for (const change of [{ success: false }, { hostname: "attacker.example" }, { action: "other" }, { cdata: `${creatorPublicId}_${randomUUID()}` }]) {
    assert.equal(await verifyTurnstile(input, config, fetcher({ ...success, ...change })), false);
  }
  for (const data of [null, {}, { success: false, "error-codes": ["internal-error"] }, { success: false, "error-codes": ["invalid-input-secret"] }]) {
    await assert.rejects(verifyTurnstile(input, config, fetcher(data)), error => error.status === 503);
  }
  await assert.rejects(verifyTurnstile(input, config, async () => { throw Error("secret provider failure"); }), error => error.status === 503);
  await assert.rejects(verifyTurnstile(input, config, async () => new Response("bad", { status: 503 })), error => error.status === 503);
  await assert.rejects(verifyTurnstile(input, config, async () => new Response("not json")), error => error.status === 503);
});

test("disabled, invalid origin/config, malformed payload and honeypot never allocate database work", async () => {
  for (const [req, settings, expected] of [
    [request(), { ...config, enabled: false }, 404],
    [request(), { ...config, hmacSecret: "short" }, 503],
    [request(), { ...config, vercel: false }, 503],
    [request(input, { origin: "https://attacker.example" }), config, 403],
    [request(input, { origin: "" }), config, 403],
    [request(input, { "sec-fetch-site": "cross-site" }), config, 403],
    [request({ ...input, website: "bot.example" }), config, 400],
    [request({ ...input, message: "short" }), config, 400],
  ]) {
    const d = dependencies();
    assert.equal((await handleInquiry(req, settings, d.store, d.verify)).status, expected);
    assert.deepEqual(d.calls, []);
  }
});

test("durable attempt quota runs before Turnstile and only verified requests finish", async () => {
  const d = dependencies();
  const response = await handleInquiry(request(), config, d.store, d.verify);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { message: "Your inquiry has been received.", receipt });
  assert.deepEqual(d.calls.map(call => call[0]), ["begin", "verify", "finish"]);
  assert.match(d.calls[0][1].ipHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(d.calls[0]).includes(input.senderEmail));
  assert.match(d.calls[2][3], /^[a-f0-9]{64}$/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("set-cookie"), null);
  const failed = dependencies({ verified: false });
  assert.equal((await handleInquiry(request(), config, failed.store, failed.verify)).status, 403);
  assert.deepEqual(failed.calls.map(call => call[0]), ["begin", "verify"]);
});

for (const [status, expected] of Object.entries({ throttled: 429, conflict: 409, "not-found": 404, replay: 403, expired: 403, invalid: 400, unknown: 503 })) {
  test(`database outcome ${status} is safely mapped`, async () => {
    const d = dependencies({ begin: { status } });
    const response = await handleInquiry(request(), config, d.store, d.verify);
    assert.equal(response.status, expected);
    assert.deepEqual(d.calls.map(call => call[0]), ["begin"]);
    if (expected === 429) assert.equal(response.headers.get("retry-after"), "86400");
  });
}

test("lost-response retry returns its receipt without re-verifying a consumed token", async () => {
  const d = dependencies({ begin: { status: "accepted", receipt } });
  assert.equal((await handleInquiry(request(), config, d.store, d.verify)).status, 200);
  assert.deepEqual(d.calls.map(call => call[0]), ["begin"]);
});

test("cookies are neither required nor trusted for inquiry authorization and never produce session cookies", async () => {
  const cookieHeader = { cookie: "sb-session=fake-token; other=value", "sec-fetch-site": "same-origin" };
  const badOrigin = dependencies();
  const rejected = await handleInquiry(request(input, { ...cookieHeader, origin: "https://attacker.example" }), config, badOrigin.store, badOrigin.verify);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("set-cookie"), null);
  assert.deepEqual(badOrigin.calls, []);

  const unverified = dependencies({ verified: false });
  const failedTurnstile = await handleInquiry(request(input, cookieHeader), config, unverified.store, unverified.verify);
  assert.equal(failedTurnstile.status, 403);
  assert.equal(failedTurnstile.headers.get("set-cookie"), null);
  assert.deepEqual(unverified.calls.map(call => call[0]), ["begin", "verify"]);

  const ok = dependencies();
  const accepted = await handleInquiry(request(input, cookieHeader), config, ok.store, ok.verify);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("set-cookie"), null);
  assert.deepEqual(ok.calls.map(call => call[0]), ["begin", "verify", "finish"]);
  assert.ok(!JSON.stringify(ok.calls).includes("sb-session"));
});

test("upstream exceptions and malformed database successes never leak details or report success", async () => {
  const response = await handleInquiry(request(), config, () => { throw Error("postgres://credentials@private-host sender@example.test"); });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /postgres|credentials|private-host|sender@/);
  for (const begin of [{ status: "ready", ticket: "bad" }, { status: "accepted", receipt: "bad" }]) {
    const d = dependencies({ begin });
    assert.equal((await handleInquiry(request(), config, d.store, d.verify)).status, 503);
  }
});
