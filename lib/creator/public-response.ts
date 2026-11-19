import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { isCanonicalCreatorSlug, readPublicCreator } from "./public-profile";
import { encodePublicProfile, PUBLIC_PROFILE_HEADER } from "./public-request";
import { publicStatusDocument } from "./public-status";

export async function publicCreatorResponse(request: NextRequest) {
  // This function is called only for the single /c/[slug] route shape.
  // Encoded or noncanonical slugs deliberately fail validation without a lookup.
  const slug = request.nextUrl.pathname.slice(3);
  let result: Awaited<ReturnType<typeof readPublicCreator>>;
  try {
    result = isCanonicalCreatorSlug(slug)
      ? await readPublicCreator(createPublicClient(), slug)
      : { status: "not-found" };
  } catch {
    result = { status: "unavailable" };
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(PUBLIC_PROFILE_HEADER);
  let response: NextResponse;
  if (result.status === "found") {
    requestHeaders.set(PUBLIC_PROFILE_HEADER, encodePublicProfile(result.profile));
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    const status = result.status === "not-found" ? 404 : 503;
    response = new NextResponse(request.method === "HEAD" ? null : publicStatusDocument(status), {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    response.headers.set("X-Robots-Tag", "noindex");
  }
  // Publication changes must be visible on the next request, including at CDNs.
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}
