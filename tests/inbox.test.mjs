import assert from "node:assert/strict";
import { test } from "node:test";
import { readInbox, readInquiry, parseInboxCursor, INBOX_PAGE_SIZE } from "../lib/inquiries/inbox.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const item = { id, sender_name: "Brand", company: null, created_at: "2026-11-20T07:00:00.123456+00:00", message_preview: "A proposal" };
function fixture({ user = { id: owner }, authError = null, profile = { user_id: owner }, data = [], error = null, throws = false } = {}) {
  const calls = [];
  const client = {
    auth: { async getUser() { calls.push(["auth"]); return { data: { user }, error: authError }; } },
    from(table) { calls.push(["from", table]); return {
      select(fields) { calls.push(["select", fields]); return this; },
      eq(field, value) { calls.push(["eq", field, value]); return this; },
      async maybeSingle() { return { data: profile, error: null }; },
    }; },
    async rpc(name, args) { calls.push(["rpc", name, args]); if (throws) throw new Error("private sender@example.test"); return { data, error }; },
  };
  return { client, calls };
}

test("inbox verifies missing/expired sessions before profile or inquiry access", async () => {
  for (const options of [{ user: null }, { authError: { message: "expired" } }]) {
    for (const read of [c => readInbox(c, {}), c => readInquiry(c, id)]) {
      const f = fixture(options);
      assert.deepEqual(await read(f.client), { status: "unauthenticated" });
      assert.deepEqual(f.calls, [["auth"]]);
    }
  }
});
test("inbox requires onboarding; empty inbox is distinct from database failure", async () => {
  assert.deepEqual(await readInbox(fixture({ profile: null }).client, {}), { status: "onboarding" });
  assert.deepEqual(await readInbox(fixture().client, {}), { status: "ready", items: [], nextCursor: null });
  for (const options of [{ error: { message: "private database content" } }, { throws: true }, { data: null }]) {
    assert.deepEqual(await readInbox(fixture(options).client, {}), { status: "error" });
    assert.deepEqual(await readInquiry(fixture(options).client, id), { status: "error" });
  }
  assert.deepEqual(await readInbox(fixture({ error: { code: "PGRST301" } }).client, {}), { status: "unauthenticated" });
});
test("bounded cursor pagination preserves microseconds and strips extra private columns", async () => {
  const data = Array.from({ length: 21 }, (_, n) => ({ ...item, id: `22222222-2222-4222-8222-${String(100-n).padStart(12,"0")}`, sender_email: "private@example.test", message: "full private message" }));
  const f = fixture({ data });
  const result = await readInbox(f.client, {});
  assert.equal(result.items.length, INBOX_PAGE_SIZE);
  assert.deepEqual(f.calls.find(c => c[0] === "eq"), ["eq", "user_id", owner]);
  assert.deepEqual(f.calls.find(c => c[0] === "rpc"), ["rpc", "list_creator_inquiries", { p_before_created_at: null, p_before_id: null, p_limit: 21 }]);
  const cursor = parseInboxCursor(result.nextCursor);
  assert.deepEqual(cursor, { id: data[19].id, created_at: item.created_at });
  assert.doesNotMatch(JSON.stringify(result), /private@example|full private|sender_email/);
  const next = fixture({ data: [item] });
  assert.equal((await readInbox(next.client, { cursor: result.nextCursor })).nextCursor, null);
  assert.deepEqual(next.calls.find(c => c[0] === "rpc")[2], { p_before_created_at: item.created_at, p_before_id: data[19].id, p_limit: 21 });
  assert.deepEqual(await readInbox(fixture({ data: [...data, item] }).client, {}), { status: "error" });
});
test("forged owner parameters and malformed cursors cannot reach inquiry queries", async () => {
  const encode = v => Buffer.from(JSON.stringify(v)).toString("base64url");
  for (const params of [{ creatorId: id }, { user_id: id }, { cursor: ["a", "b"] }, { cursor: "" }, { cursor: "x".repeat(257) },
    { cursor: encode({ ...item, creatorId: id }) }, { cursor: encode({ id, created_at: "infinity" }) }, { cursor: "../" }]) {
    const f = fixture();
    assert.deepEqual(await readInbox(f.client, params), { status: "invalid" });
    assert.ok(!f.calls.some(c => c[0] === "rpc"));
  }
});
test("detail returns only approved fields; missing and malformed IDs are unavailable", async () => {
  const data = [{ ...item, sender_email: "brand@example.test", message: "<script>plain text</script>", creator_public_id: owner, token_hash: "private" }];
  const f = fixture({ data });
  const result = await readInquiry(f.client, id);
  assert.equal(result.status, "ready");
  assert.equal(result.inquiry.message, data[0].message);
  assert.deepEqual(Object.keys(result.inquiry).sort(), ["id", "created_at", "sender_name", "sender_email", "company", "message"].sort());
  assert.deepEqual(f.calls.find(c => c[0] === "rpc"), ["rpc", "get_creator_inquiry", { p_inquiry_id: id }]);
  assert.deepEqual(await readInquiry(fixture().client, id), { status: "not-found" });
  const invalid = fixture();
  assert.deepEqual(await readInquiry(invalid.client, "../bad"), { status: "not-found" });
  assert.ok(!invalid.calls.some(c => c[0] === "rpc"));
});

test("calendar-invalid and malformed timestamps return invalid before any inquiry RPC", async () => {
  const invalidDates = ["2026-02-31", "2026-02-29", "1900-02-29", "2100-02-29", "2024-02-30",
    "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31", "2026-00-01", "2026-13-01",
    "2026-01-00", "2026-01-32", "0000-01-01"];
  const invalidTimestamps = [
    ...invalidDates.flatMap(date => [date + "T12:00:00.123456Z", date + "T00:00:00.000001-05:30"]),
    "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z", "2026-01-01T12:00:60Z",
    "2026-01-01T12:00:00+16:00", "2026-01-01T12:00:00-16:00", "2026-01-01T12:00:00+05:60",
    "2026-01-01T12:00:00.1234567Z", "2026-01-01T12:00:00", "2026-1-1T12:00:00Z",
    "2026-01-01T12:00:00Z\n", " 2026-01-01T12:00:00Z",
  ];
  for (const created_at of invalidTimestamps) {
    const cursor = Buffer.from(JSON.stringify({ id, created_at })).toString("base64url");
    assert.equal(parseInboxCursor(cursor), null, created_at);
    const f = fixture();
    assert.deepEqual(await readInbox(f.client, { cursor }), { status: "invalid" }, created_at);
    assert.ok(!f.calls.some(c => c[0] === "rpc"), created_at);
  }
});

test("valid leap years, offsets and microseconds survive pagination without normalization", async () => {
  for (const created_at of [
    "2024-02-29T23:59:59.123456Z", "2000-02-29T00:00:00.000001+05:45", "2400-02-29T12:00:00-03:30",
    "2026-02-28T23:59:59.999999-12:00", "2026-03-01T00:00:00.123456+14:00",
    "2026-11-20T07:00:00.1+07:00", "2026-11-20T07:00:00+00:00",
    "2026-11-20T07:00:00.000001+15:59", "2026-11-20T07:00:00.000001-15:59",
    "0096-02-29T00:00:00Z",
  ]) {
    const data = Array.from({ length: 21 }, () => ({ ...item, created_at }));
    const result = await readInbox(fixture({ data }).client, {});
    assert.equal(result.status, "ready", created_at);
    assert.deepEqual(parseInboxCursor(result.nextCursor), { id, created_at });
    const next = fixture();
    assert.equal((await readInbox(next.client, { cursor: result.nextCursor })).status, "ready");
    assert.equal(next.calls.find(c => c[0] === "rpc")[2].p_before_created_at, created_at);
  }
});
