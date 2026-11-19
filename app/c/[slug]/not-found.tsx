import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Creator page not found</h1>
      <p className="mt-4 leading-relaxed text-muted-foreground">This page isn’t available. Check the link and try again.</p>
      <Link href="/" className="mt-6 text-sm font-medium underline underline-offset-4">Back to CollabFlow</Link>
    </main>
  );
}
