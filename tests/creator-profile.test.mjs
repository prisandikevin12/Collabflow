import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESERVED_SLUGS, normalizeSlug, validateProfile, saveOwnProfile, getCreatorContext,
} from "../lib/creator/profile.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const profile = { user_id: owner, display_name: "Alex Studio", slug: "alex-studio", bio: null };
function form(values = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ display_name: "Alex Studio", slug: "alex-studio", bio: "", ...values })) data.set(key, value);
  return data;
}

// Mock the remote boundary, not the implementation: record filters and writes,
// and provide the responses a real PostgREST/auth server would return.
function client({ user = { id: owner }, authError = null, responses = [], throws = false } = {}) {
  const calls = [];
  const db = {
    auth: { async getUser() {
      calls.push(["getUser"]);
      if (throws) throw new Error("private network details");
      return { data: { user }, error: authError };
    } },
    from(table) {
      calls.push(["from", table]);
      const query = {};
      for (const method of ["select", "eq", "insert", "update"]) {
        query[method] = (...args) => { calls.push([method, ...args]); return query; };
      }
      query.maybeSingle = async () => {
        assert.ok(responses.length, "Unexpected database query");
        return responses.shift();
      };
      return query;
    },
  };
  return { db, calls };
}
const ok = (data) => ({ data, error: null });
const failure = (code) => ({ data: null, error: { code, message: `private database details: ${other}` } });

test("normalization lowercases and trims without inventing a different slug", () => {
  assert.equal(normalizeSlug("  Alex-Studio  "), "alex-studio");
  assert.equal(normalizeSlug("Alex Studio"), "alex studio");
  const result = validateProfile(form({ display_name: "  Alex  ", slug: " ALEX-STUDIO ", bio: "  Hello  " }));
  assert.deepEqual(result, { values: { display_name: "Alex", slug: "alex-studio", bio: "Hello" } });
});

for (const slug of ["", "ab", "a".repeat(41), "-alex", "alex-", "alex--studio", "alex_studio", "alex studio", "álex", "../alex", "alex/example", "%61lex", "alex?x=1", "alex\nname"]) {
  test(`rejects invalid slug ${JSON.stringify(slug)}`, () => assert.ok(validateProfile(form({ slug })).errors?.slug));
}
for (const slug of RESERVED_SLUGS) {
  test(`rejects reserved slug ${slug} after normalization`, () => assert.match(validateProfile(form({ slug: ` ${slug.toUpperCase()} ` })).errors.slug, /reserved/));
}
test("validation accepts exact boundaries and counts Unicode code points", () => {
  assert.equal(validateProfile(form({ display_name: "😀".repeat(60), slug: "a".repeat(40), bio: "😀".repeat(280) })).errors, undefined);
  assert.equal(validateProfile(form({ display_name: "Al", slug: "a-1" })).errors, undefined);
  for (const display_name of ["", " ", "A", "a".repeat(61), "a\u0000b", "a\nb"]) assert.ok(validateProfile(form({ display_name })).errors?.display_name);
  for (const bio of ["b".repeat(281), "line\nbreak", "null\u0000byte"]) assert.ok(validateProfile(form({ bio })).errors?.bio);
});
test("rejects files and repeated fields; missing optional bio is accepted", () => {
  const data = form();
  data.set("display_name", new Blob(["name"]));
  data.append("slug", "second-slug");
  data.delete("bio");
  assert.ok(validateProfile(data).errors.display_name);
  assert.ok(validateProfile(data).errors.slug);
  assert.equal(validateProfile(form()).values.bio, "");
  assert.ok(validateProfile(new FormData()).errors.display_name);
});

test("anonymous and rejected sessions cannot read a profile", async () => {
  for (const config of [{ user: null }, { authError: new Error("expired") }]) {
    const { db, calls } = client(config);
    assert.deepEqual(await getCreatorContext(db), { status: "unauthenticated" });
    assert.deepEqual(calls, [["getUser"]]);
  }
});
test("profile reads are scoped to the verified user and normalize nullable bio", async () => {
  const { db, calls } = client({ responses: [ok(profile)] });
  assert.deepEqual(await getCreatorContext(db), { status: "ready", profile: { ...profile, bio: "" } });
  assert.ok(calls.some(([method, field, id]) => method === "eq" && field === "user_id" && id === owner));
});
test("missing profiles and database failures have distinct outcomes", async () => {
  assert.deepEqual(await getCreatorContext(client({ responses: [ok(null)] }).db), { status: "ready", profile: null });
  assert.deepEqual(await getCreatorContext(client({ responses: [failure("42P01")] }).db), { status: "error" });
  assert.deepEqual(await getCreatorContext(client({ throws: true }).db), { status: "error" });
});

for (const mode of ["create", "update"]) {
  test(`${mode} requires a verified session before database access`, async () => {
    for (const config of [{ user: null }, { authError: new Error("expired") }]) {
      const { db, calls } = client(config);
      assert.equal((await saveOwnProfile(db, mode, form())).destination, "/auth/login");
      assert.deepEqual(calls, [["getUser"]]);
    }
  });
  test(`${mode} does not write invalid fields`, async () => {
    const { db, calls } = client({ responses: mode === "create" ? [ok(null)] : [] });
    assert.ok((await saveOwnProfile(db, mode, form({ slug: "admin" }))).errors.slug);
    assert.ok(!calls.some(([method]) => ["insert", "update"].includes(method)));
  });
  test(`${mode} handles unique slug conflicts without exposing database details`, async () => {
    const { db } = client({ responses: mode === "create" ? [ok(null), failure("23505"), ok(null)] : [failure("23505")] });
    const result = await saveOwnProfile(db, mode, form());
    assert.match(result.errors.slug, /already taken/);
    assert.equal(result.success, undefined);
    assert.ok(!JSON.stringify(result).includes(other));
  });
  test(`${mode} masks permission and database errors`, async () => {
    const { db } = client({ responses: mode === "create" ? [ok(null), failure("42501")] : [failure("42501")] });
    const result = await saveOwnProfile(db, mode, form());
    assert.match(result.message, /try again/);
    assert.ok(!JSON.stringify(result).includes(other));
    assert.equal(result.success, undefined);
  });
}
test("create derives ownership from auth and only inserts approved fields", async () => {
  const { db, calls } = client({ responses: [ok(null), ok({ user_id: owner })] });
  const result = await saveOwnProfile(db, "create", form({ user_id: other, created_at: "forged", slug: " ALEX-STUDIO " }));
  assert.equal(result.destination, "/dashboard");
  assert.deepEqual(calls.find(([method]) => method === "insert"), ["insert", { display_name: "Alex Studio", slug: "alex-studio", bio: null, user_id: owner }]);
});
test("existing profiles cannot be overwritten through onboarding", async () => {
  const { db, calls } = client({ responses: [ok(profile)] });
  assert.equal((await saveOwnProfile(db, "create", form())).destination, "/dashboard");
  assert.ok(!calls.some(([method]) => ["insert", "update"].includes(method)));
});
test("concurrent creation resolves to dashboard without an upsert", async () => {
  const { db, calls } = client({ responses: [ok(null), failure("23505"), ok(profile)] });
  assert.equal((await saveOwnProfile(db, "create", form())).destination, "/dashboard");
  assert.equal(calls.filter(([method]) => method === "insert").length, 1);
  assert.ok(!calls.some(([method]) => method === "update"));
});
test("update cannot choose another owner or change immutable fields", async () => {
  const { db, calls } = client({ responses: [ok({ user_id: owner })] });
  const result = await saveOwnProfile(db, "update", form({ user_id: other, updated_at: "forged" }));
  assert.equal(result.success, true);
  assert.deepEqual(calls.find(([method]) => method === "update"), ["update", { display_name: "Alex Studio", slug: "alex-studio", bio: null }]);
  assert.deepEqual(calls.find(([method]) => method === "eq"), ["eq", "user_id", owner]);
});
test("zero-row update does not report success", async () => {
  const result = await saveOwnProfile(client({ responses: [ok(null)] }).db, "update", form());
  assert.equal(result.destination, "/onboarding");
  assert.equal(result.success, undefined);
});
test("network errors produce a retryable message and retain entered values", async () => {
  const result = await saveOwnProfile(client({ throws: true }).db, "create", form());
  assert.match(result.message, /try again/);
  assert.equal(result.values.slug, "alex-studio");
});
