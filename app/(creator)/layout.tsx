import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";

export default function CreatorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-muted/30">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:block focus:p-4">Skip to content</a>
      <header className="border-b bg-background">
        <nav aria-label="Main navigation" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link href="/dashboard" className="text-xl font-semibold tracking-tight">CollabFlow<span className="text-muted-foreground">.</span></Link>
          <div className="flex items-center gap-4 sm:gap-6">
            <Link href="/dashboard" className="text-sm font-medium underline-offset-4 hover:underline">Dashboard</Link>
            <LogoutButton />
          </div>
        </nav>
      </header>
      <main id="main-content" className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">{children}</main>
      <footer className="mx-auto max-w-6xl px-5 pb-8 text-xs text-muted-foreground sm:px-8">CollabFlow · Your creator workspace</footer>
    </div>
  );
}
