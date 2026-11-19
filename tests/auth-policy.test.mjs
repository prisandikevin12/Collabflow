import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSafeAuthRedirect,
  isEmailOtpType,
  isPublicPath,
} from "../lib/auth/policy.ts";

test("confirmation preserves existing login and recovery destinations", () => {
  for (const path of ["/", "/protected", "/auth/update-password"]) {
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
    "/protected", "/protected/settings", "/dashboard", "/api/private",
    "/login", "/login-admin", "/author", "/authentication", "/auth/admin",
    "/auth/login/admin", "/auth/login-extra", "/c/example",
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
