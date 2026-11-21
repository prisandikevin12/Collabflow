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

const authRedirectPaths = new Set([
  "/", "/protected", "/dashboard", "/onboarding", "/auth/update-password",
]);

const emailOtpTypes = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";
export const PRIVATE_ROBOTS_TAG = "noindex, nofollow";

export const DEFAULT_AUTH_ERROR_MESSAGE =
  "We couldn’t complete your authentication request. Please sign in or request a new link.";

const authErrorMessages = new Map<string, string>([
  ["confirm_failed", "Unable to confirm this link. Please request a new one."],
  ["invalid_link", "Invalid confirmation link. Please request a new one."],
]);

export function isPublicPath(pathname: string): boolean {
  return publicPaths.has(pathname) || isPublicCreatorPath(pathname);
}

// Exactly one route segment, including invalid slugs so they receive a 404,
// not a login redirect. Never exempt nested paths or the entire /c prefix.
export function isPublicCreatorPath(pathname: string): boolean {
  return /^\/c\/[^/]+$/.test(pathname);
}

export function isPrivateAppPath(pathname: string): boolean {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/onboarding" ||
    pathname.startsWith("/onboarding/") ||
    pathname === "/protected" ||
    pathname.startsWith("/protected/")
  );
}

export function applyPrivateRouteHeaders(headers: Pick<Headers, "set">): void {
  headers.set("Cache-Control", PRIVATE_CACHE_CONTROL);
  headers.set("X-Robots-Tag", PRIVATE_ROBOTS_TAG);
}

export function getAuthErrorMessage(
  code: string | string[] | null | undefined,
): string {
  if (typeof code !== "string") return DEFAULT_AUTH_ERROR_MESSAGE;
  return authErrorMessages.get(code) ?? DEFAULT_AUTH_ERROR_MESSAGE;
}

export function getCreatorRedirect(pathname: string, hasProfile: boolean): string | null {
  const destination = hasProfile ? "/dashboard" : "/onboarding";
  return pathname === destination ? null : destination;
}

export function getSafeAuthRedirect(destination: string | null): string {
  // Exact paths reject external URLs, encoded bypasses, and untrusted queries.
  return destination && authRedirectPaths.has(destination) ? destination : "/";
}

export function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && emailOtpTypes.has(value);
}
