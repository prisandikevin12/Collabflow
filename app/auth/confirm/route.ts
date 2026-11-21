import { createClient } from "@/lib/supabase/server";
import { getSafeAuthRedirect, isEmailOtpType } from "@/lib/auth/policy";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = getSafeAuthRedirect(searchParams.get("next"));

  if (token_hash && isEmailOtpType(type)) {
    const supabase = await createClient();

    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash,
    });
    if (!error) {
      // Only redirect to an explicitly supported destination.
      redirect(next);
    } else {
      // Redirect with a fixed allowlisted error code; never pass raw error prose.
      redirect("/auth/error?error=confirm_failed");
    }
  }

  // Redirect with a fixed allowlisted error code.
  redirect("/auth/error?error=invalid_link");
}
