import { updateSession } from "@/lib/supabase/proxy";
import { NextResponse, type NextRequest } from "next/server";
import { isPublicCreatorPath } from "@/lib/auth/policy";
import { publicCreatorResponse } from "@/lib/creator/public-response";

export async function proxy(request: NextRequest) {
  // Exact endpoint only: intake performs its own origin and abuse checks.
  if (request.nextUrl.pathname === "/api/inquiries") return NextResponse.next();
  if (isPublicCreatorPath(request.nextUrl.pathname)) {
    return publicCreatorResponse(request);
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Include invalid image-like slugs and nested paths in the normal guard.
    "/c/:path*",
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - images - .svg, .png, .jpg, .jpeg, .gif, .webp
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
