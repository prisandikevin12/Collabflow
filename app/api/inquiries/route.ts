import { handleInquiry } from "@/lib/inquiries/intake";
import { inquiryConfig, inquiryStore } from "@/lib/inquiries/server";

// Use the default Node runtime; explicit segment runtime is incompatible with
// this project's Cache Components configuration.

export async function POST(request: Request) {
  return handleInquiry(request, inquiryConfig(), inquiryStore);
}

function methodNotAllowed() {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export { methodNotAllowed as GET, methodNotAllowed as HEAD, methodNotAllowed as PUT,
  methodNotAllowed as PATCH, methodNotAllowed as DELETE, methodNotAllowed as OPTIONS };
