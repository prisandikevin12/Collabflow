import { SignUpForm } from "@/components/sign-up-form";
import { AuthEntryRedirect } from "@/components/auth-entry-redirect";
import { Suspense } from "react";

export default function Page() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <Suspense><AuthEntryRedirect /></Suspense>
      <div className="w-full max-w-sm">
        <SignUpForm />
      </div>
    </div>
  );
}
