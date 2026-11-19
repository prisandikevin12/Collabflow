import { Suspense } from "react";
import { requireCreatorContext } from "@/lib/creator/server";

async function LegacyDestination() {
  await requireCreatorContext("/protected");
  return null;
}

// Preserve previously issued confirmation links and bookmarks.
export default function ProtectedPage() {
  return <Suspense fallback={<p role="status">Opening your workspace…</p>}><LegacyDestination /></Suspense>;
}
