import assert from "node:assert/strict";
import { test } from "node:test";
import { readPublicCreator, isCanonicalCreatorSlug } from "../lib/creator/public-profile.ts";
import { setOwnPublication } from "../lib/creator/publication.ts";
import { isPublicPath, getSafeAuthRedirect } from "../lib/auth/policy.ts";

const owner = "11111111-1111-4111-8111-111111111111";
function client({ user = { id: owner }, authError = null, data = null, error = null, throws = false } = {}) {
  const calls = [];
  const query = {};
  for (const method of ["select", "eq", "update"]) query[method] = (...args) => {
    calls.push([method, ...args]); return query;
  };
  query.maybeSingle = async () => {
    if (throws) throw new Error("private database detail");
    return { data, error };
  };
  return { calls, db: {
    auth: { getUser: async () => { calls.push(["getUser"]); return { data: { user }, error: authError }; } },
    from: (table) => { calls.push(["from", table]); return query; },
  } };
}

test("public routing allows only a single creator segment, not nested routes or auth redirect destinations", () => {
  for (const path of ["/c/example", "/c/Bad-Slug", "/c/ab", "/c/%2Fprivate", "/c/admin"]) {
    assert.equal(isPublicPath(path), true);
    assert.equal(getSafeAuthRedirect(path), "/");
  }
  for (const path of ["/c", "/c/", "/c//", "/c/example/settings", "/c/example/", "/creators/example", "/api/inquiries"]) {
    assert.equal(isPublicPath(path), false);
  }
});

test("canonical slugs have strict length and ASCII format", () => {
  for (const slug of ["abc", "a-1", "a".repeat(40)]) assert.equal(isCanonicalCreatorSlug(slug), true);
  for (const slug of ["", "ab", "a".repeat(41), "ABC", "-abc", "abc-", "a--b", "a_b", "a/b", "a\\b", "%61bc", "abc ", "ábc"]) assert.equal(isCanonicalCreatorSlug(slug), false);
});

test("invalid slugs are not sent to the database", async () => {
  const { db, calls } = client();
  assert.deepEqual(await readPublicCreator(db, "Bad-Slug"), { status: "not-found" });
  assert.deepEqual(calls, []);
});

test("public lookup uses only the projection, filters slug, and strips unexpected private fields", async () => {
  const safe = { public_id: "public-id", slug: "alex-studio", display_name: "Alex", bio: null };
  const { db, calls } = client({ data: { ...safe, user_id: owner, email: "secret@example.test", is_public: true } });
  assert.deepEqual(await readPublicCreator(db, "alex-studio"), { status: "found", profile: safe });
  assert.deepEqual(calls, [["from", "creator_public_profiles"], ["select", "public_id, slug, display_name, bio"], ["eq", "slug", "alex-studio"]]);
});

test("unpublished and unknown rows have identical results; database failures are not 404s", async () => {
  assert.deepEqual(await readPublicCreator(client().db, "unknown"), { status: "not-found" });
  for (const setup of [{ error: { code: "42P01", message: "private" } }, { throws: true }]) {
    assert.deepEqual(await readPublicCreator(client(setup).db, "example"), { status: "unavailable" });
  }
});

function publicationForm(value) {
  const form = new FormData();
  if (value !== undefined) form.set("is_public", value);
  return form;
}

test("publication requires a verified user before writes", async () => {
  for (const setup of [{ user: null }, { authError: new Error("revoked") }]) {
    const { db, calls } = client(setup);
    assert.deepEqual(await setOwnPublication(db, publicationForm("true")), { destination: "/auth/login" });
    assert.deepEqual(calls, [["getUser"]]);
  }
});

test("publication accepts only one explicit boolean string", async () => {
  const duplicate = publicationForm("true"); duplicate.append("is_public", "false");
  for (const form of [publicationForm(), publicationForm("on"), publicationForm("1"), publicationForm("TRUE"), publicationForm(new Blob(["true"])), duplicate]) {
    const { db, calls } = client();
    assert.match((await setOwnPublication(db, form)).message, /Choose/);
    assert.deepEqual(calls, [["getUser"]]);
  }
});

for (const isPublic of [true, false]) test(`publication ${isPublic} ignores forged identities and changes only the authenticated owner's flag`, async () => {
  const { db, calls } = client({ data: { is_public: isPublic } });
  const form = publicationForm(String(isPublic));
  form.set("user_id", "other-user"); form.set("public_id", "forged"); form.set("slug", "forged-slug");
  assert.equal((await setOwnPublication(db, form)).success, true);
  assert.deepEqual(calls, [["getUser"], ["from", "creator_profiles"], ["update", { is_public: isPublic }], ["eq", "user_id", owner], ["select", "is_public"]]);
});

test("publication does not report success for zero rows or failures", async () => {
  assert.deepEqual(await setOwnPublication(client().db, publicationForm("true")), { destination: "/onboarding" });
  for (const setup of [{ error: { message: "secret" } }, { throws: true }]) {
    const result = await setOwnPublication(client(setup).db, publicationForm("true"));
    assert.equal(result.success, undefined);
    assert.match(result.message, /try again/);
    assert.doesNotMatch(result.message, /secret|private database/);
  }
});
