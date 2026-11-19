import type { EmailOtpType } from "@supabase/supabase-js";

// Keep these explicit: adding a route must not accidentally make it public.
const publicPaths = new Set([
  "/",
  "/auth/login",
  "/auth/sign-up",
  "/auth/sign-up-success",
  "/auth/forgot-password",
  "/auth/update-password",
  "/auth/confirm",
  "/auth/error",
]);

const authRedirectPaths = new Set(["/", "/protected", "/auth/update-password"]);

const emailOtpTypes = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export function isPublicPath(pathname: string): boolean {
  return publicPaths.has(pathname);
}

export function getSafeAuthRedirect(destination: string | null): string {
  // Exact paths reject external URLs, encoded bypasses, and untrusted queries.
  return destination && authRedirectPaths.has(destination) ? destination : "/";
}

export function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && emailOtpTypes.has(value);
}
