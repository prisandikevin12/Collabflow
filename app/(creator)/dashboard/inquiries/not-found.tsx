import Link from "next/link";

export default function NotFound() {
  return <section className="rounded-xl border bg-background p-6 sm:p-8">
    <h1 className="text-2xl font-semibold">Inquiry unavailable</h1>
    <p className="my-4 text-muted-foreground">This inquiry could not be found in your inbox.</p>
    <Link href="/dashboard/inquiries" prefetch={false} className="underline underline-offset-4">Back to inbox</Link>
  </section>;
}
