import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applyPrivateRouteHeaders,
  DEFAULT_AUTH_ERROR_MESSAGE,
  getAuthErrorMessage,
  getSafeAuthRedirect,
  getCreatorRedirect,
  isEmailOtpType,
  isPrivateAppPath,
  isPublicPath,
  PRIVATE_CACHE_CONTROL,
  PRIVATE_ROBOTS_TAG,
} from "../lib/auth/policy.ts";

test("creator routing sends users to the correct page without loops", () => {
  for (const pathname of ["/", "/protected", "/onboarding", "/dashboard"]) {
    for (const hasProfile of [true, false]) {
      const expected = hasProfile ? "/dashboard" : "/onboarding";
      const destination = getCreatorRedirect(pathname, hasProfile);
      assert.equal(destination, pathname === expected ? null : expected);
      if (destination) assert.equal(getCreatorRedirect(destination, hasProfile), null);
    }
  }
});

test("confirmation preserves existing login and recovery destinations", () => {
  for (const path of ["/", "/protected", "/dashboard", "/onboarding", "/auth/update-password"]) {
    assert.equal(getSafeAuthRedirect(path), path);
  }
});

for (const destination of [
  null,
  "",
  "https://attacker.example",
  "//attacker.example",
  "/\\attacker.example",
  "javascript:alert(1)",
  "data:text/html,redirect",
  "https://localhost/protected",
  "%2F%2Fattacker.example",
  "/%2f%2fattacker.example",
  "/protected/../auth/confirm",
  "/protected?next=https://attacker.example",
  "/protected#fragment",
  "/dashboard?next=https://attacker.example",
  "/onboarding#fragment",
  "/dashboard/../auth/confirm",
  "%2Fdashboard",
  "/dashboard/",
  "/auth/confirm",
  "/unknown",
  "/protected\r\nLocation: https://attacker.example",
]) {
  test(`confirmation rejects unapproved destination ${JSON.stringify(destination)}`, () => {
    assert.equal(getSafeAuthRedirect(destination), "/");
  });
}

test("only existing landing and authentication routes are public", () => {
  for (const path of [
    "/", "/auth/login", "/auth/sign-up", "/auth/sign-up-success",
    "/auth/forgot-password", "/auth/update-password", "/auth/confirm", "/auth/error",
  ]) {
    assert.equal(isPublicPath(path), true, path);
  }
});

test("protected, unknown, and auth-prefix lookalike routes remain guarded", () => {
  for (const path of [
    "/protected", "/protected/settings", "/dashboard", "/onboarding", "/api/private",
    "/login", "/login-admin", "/author", "/authentication", "/auth/admin",
    "/auth/login/admin", "/auth/login-extra", "/c/example/settings", "/c", "/creators/example",
  ]) {
    assert.equal(isPublicPath(path), false, path);
  }
});

test("accepts supported email confirmation types, including recovery", () => {
  for (const type of ["signup", "invite", "magiclink", "recovery", "email_change", "email"]) {
    assert.equal(isEmailOtpType(type), true, type);
  }
});

test("rejects missing, unknown, and non-email confirmation types", () => {
  for (const type of [null, "", "sms", "phone_change", "RECOVERY", "unknown"]) {
    assert.equal(isEmailOtpType(type), false, String(type));
  }
});

test("auth error page maps only allowlisted codes and never reflects arbitrary text", () => {
  assert.equal(
    getAuthErrorMessage("confirm_failed"),
    "Unable to confirm this link. Please request a new one.",
  );
  assert.equal(
    getAuthErrorMessage("invalid_link"),
    "Invalid confirmation link. Please request a new one.",
  );
  for (const untrusted of [
    undefined,
    null,
    "",
    "Unable to confirm this link. Please request a new one.",
    "Your account is locked. Visit https://attacker.example",
    "<script>alert(1)</script>",
    "__proto__",
    "constructor",
    "toString",
    ["confirm_failed", "extra"],
  ]) {
    const resolved = getAuthErrorMessage(untrusted);
    assert.equal(resolved, DEFAULT_AUTH_ERROR_MESSAGE);
    if (typeof untrusted === "string" && untrusted.length > 0) {
      assert.equal(resolved.includes(untrusted), false);
    }
  }
});

test("auth error page and confirm route enforce allowlisted codes and login link", () => {
  const errorPage = readFileSync(new URL("../app/auth/error/page.tsx", import.meta.url), "utf8");
  assert.match(errorPage, /getAuthErrorMessage/);
  assert.match(errorPage, /href="\/auth\/login"/);
  assert.doesNotMatch(errorPage, /Code error:/);
  assert.doesNotMatch(errorPage, /\{\s*params\.error\s*\}/);

  const confirmRoute = readFileSync(new URL("../app/auth/confirm/route.ts", import.meta.url), "utf8");
  const redirects = [...confirmRoute.matchAll(/\/auth\/error\?error=([^"'`]+)/g)].map((m) => m[1]);
  assert.deepEqual(redirects, ["confirm_failed", "invalid_link"]);
});

test("private app path matcher covers dashboard, onboarding, and protected families only", () => {
  for (const path of [
    "/dashboard",
    "/dashboard/inquiries",
    "/dashboard/inquiries/aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    "/dashboard/settings",
    "/onboarding",
    "/onboarding/step",
    "/protected",
    "/protected/legacy",
  ]) {
    assert.equal(isPrivateAppPath(path), true, path);
  }
  for (const path of [
    "/",
    "/auth/login",
    "/auth/error",
    "/c/public-creator",
    "/api/inquiries",
    "/dashboard-extra",
    "/onboarding-extra",
    "/protected-extra",
  ]) {
    assert.equal(isPrivateAppPath(path), false, path);
  }
});

test("applyPrivateRouteHeaders enforces private no-store without dropping cookies or SSR headers", () => {
  const headers = new Headers();
  headers.append("Set-Cookie", "sb-127-auth-token=refreshed; Path=/; HttpOnly");
  headers.append("Set-Cookie", "sb-127-auth-token.1=part2; Path=/; HttpOnly");
  headers.set("Expires", "0");
  headers.set("Pragma", "no-cache");
  headers.set("Location", "https://collabflow.example/auth/login");

  applyPrivateRouteHeaders(headers);

  assert.equal(headers.get("cache-control"), PRIVATE_CACHE_CONTROL);
  assert.equal(headers.get("x-robots-tag"), PRIVATE_ROBOTS_TAG);
  assert.equal(headers.get("expires"), "0");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.equal(headers.get("location"), "https://collabflow.example/auth/login");
  assert.deepEqual(headers.getSetCookie(), [
    "sb-127-auth-token=refreshed; Path=/; HttpOnly",
    "sb-127-auth-token.1=part2; Path=/; HttpOnly",
  ]);
});
