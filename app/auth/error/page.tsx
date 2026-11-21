import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DEFAULT_AUTH_ERROR_MESSAGE,
  getAuthErrorMessage,
} from "@/lib/auth/policy";

export const metadata: Metadata = {
  title: "Authentication error | CollabFlow",
  robots: { index: false, follow: false },
};

async function ErrorContent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  const message = getAuthErrorMessage(params?.error);

  return (
    <p role="alert" className="text-sm text-muted-foreground">
      {message}
    </p>
  );
}

export default function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">
                Sorry, something went wrong.
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <Suspense
                fallback={
                  <p className="text-sm text-muted-foreground">
                    {DEFAULT_AUTH_ERROR_MESSAGE}
                  </p>
                }
              >
                <ErrorContent searchParams={searchParams} />
              </Suspense>
              <Button asChild className="w-full">
                <Link href="/auth/login">Back to login</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
