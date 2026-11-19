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
      // redirect the user to an error page with some instructions
      redirect(
        "/auth/error?error=Unable%20to%20confirm%20this%20link.%20Please%20request%20a%20new%20one.",
      );
    }
  }

  // redirect the user to an error page with some instructions
  redirect("/auth/error?error=Invalid%20confirmation%20link.");
}
