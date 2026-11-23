"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptedReceipt, inquiryFeedback, submissionSnapshot, TURNSTILE_ACTION,
  type InquiryFields, type SubmissionSnapshot } from "@/lib/inquiries/client";

type Turnstile = {
  render(container: HTMLElement, options: {
    sitekey: string; action: string; cData: string; size: "flexible";
    "response-field": false; retry: "never";
    callback(token: string): void;
    "error-callback"(): void; "expired-callback"(): void;
    "timeout-callback"(): void; "unsupported-callback"(): void;
  }): string;
  remove(id: string): void;
};
declare global { interface Window { turnstile?: Turnstile } }

export function InquiryForm({ creatorPublicId, creatorSlug, siteKey }: {
  creatorPublicId: string; creatorSlug: string; siteKey: string;
}) {
  const [ready, setReady] = useState(false);
  const [fields, setFields] = useState<InquiryFields>({ senderName: "", senderEmail: "", company: "", message: "", website: "" });
  const [attempt, setAttempt] = useState<{ snapshot: SubmissionSnapshot; version: number } | null>(null);
  const lastSnapshot = useRef<SubmissionSnapshot | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [feedback, setFeedback] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const challenge = useRef<HTMLDivElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!ready || !attempt || !challenge.current || !window.turnstile) return;
    let active = true;
    const api = window.turnstile;
    const fail = () => {
      if (!active) return;
      setToken("");
      setFeedback("Verification is unavailable or expired. Select Prepare verification to retry.");
    };
    let widget: string | undefined;
    try {
      widget = api.render(challenge.current, {
        sitekey: siteKey, action: TURNSTILE_ACTION,
        cData: `${creatorPublicId}_${attempt.snapshot.id}`, size: "flexible",
        "response-field": false, retry: "never",
        callback: (value) => { if (active) { setToken(value); setFeedback(""); } },
        "error-callback": fail, "expired-callback": fail,
        "timeout-callback": fail, "unsupported-callback": fail,
      });
    } catch { fail(); }
    return () => {
      active = false;
      if (widget !== undefined) api.remove(widget);
    };
  }, [attempt, creatorPublicId, ready, siteKey]);

  useEffect(() => { if (feedback || receipt) notice.current?.focus(); }, [feedback, receipt]);

  function edit(name: keyof InquiryFields, value: string) {
    setFields(previous => ({ ...previous, [name]: value }));
    setToken("");
    setAttempt(null);
    setFeedback("");
  }

  function prepare(form: HTMLFormElement) {
    if (!form.reportValidity()) return;
    const snapshot = submissionSnapshot(lastSnapshot.current, creatorPublicId, creatorSlug, fields);
    lastSnapshot.current = snapshot;
    setToken("");
    setFeedback("");
    setAttempt(previous => ({ snapshot, version: (previous?.version ?? 0) + 1 }));
  }

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!attempt || !token) { prepare(event.currentTarget); return; }
    inFlight.current = true;
    setPending(true);
    setFeedback("");
    try {
      const response = await fetch("/api/inquiries", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ ...fields, creatorPublicId, creatorSlug,
          submissionId: attempt.snapshot.id, turnstileToken: token }),
      });
      const body: unknown = await response.json();
      const accepted = acceptedReceipt(response.status, body);
      if (accepted) setReceipt(accepted);
      else {
        if (response.status === 409) lastSnapshot.current = null;
        setFeedback(inquiryFeedback(response.status));
      }
    } catch { setFeedback(inquiryFeedback(503)); }
    finally {
      // A token may already have been consumed even when the response was lost.
      // Preserve the submission id, but require a new challenge for every retry.
      setToken(""); setAttempt(null); setPending(false); inFlight.current = false;
    }
  }

  if (receipt) return <section className="mt-8 rounded-xl border bg-background p-6 sm:p-10" aria-labelledby="inquiry-success">
    <h2 id="inquiry-success" className="text-xl font-semibold">Inquiry received</h2>
    <p ref={notice} tabIndex={-1} role="status" className="mt-3">Your inquiry has been saved for this creator. Reference: <span className="break-all font-mono text-sm">{receipt}</span></p>
  </section>;

  return <section className="mt-8 rounded-xl border bg-background p-6 sm:p-10" aria-labelledby="inquiry-heading">
    <h2 id="inquiry-heading" className="text-xl font-semibold">Propose a collaboration</h2>
    <p className="mt-3 text-sm text-muted-foreground">Share your proposal and a contact email. Your details are sent privately to this creator.</p>
    <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
      strategy="afterInteractive" onReady={() => setReady(true)}
      onError={() => { setReady(false); setFeedback("Verification could not load. Check your connection and reload this page."); }} />
    <form onSubmit={submit} className="mt-6 space-y-5">
      <fieldset disabled={pending} className="space-y-5">
        <div className="space-y-2"><Label htmlFor="inquiry-name">Your name</Label>
          <Input id="inquiry-name" name="senderName" autoComplete="name" required maxLength={100} value={fields.senderName} onChange={e => edit("senderName", e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="inquiry-email">Email</Label>
          <Input id="inquiry-email" name="senderEmail" type="email" autoComplete="email" required maxLength={254} value={fields.senderEmail} onChange={e => edit("senderEmail", e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="inquiry-company">Company (optional)</Label>
          <Input id="inquiry-company" name="company" autoComplete="organization" maxLength={120} value={fields.company} onChange={e => edit("company", e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="inquiry-message">Proposal</Label>
          <textarea id="inquiry-message" name="message" rows={7} required minLength={10} maxLength={5000}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            value={fields.message} onChange={e => edit("message", e.target.value)} aria-describedby="inquiry-message-help" />
          <p id="inquiry-message-help" className="text-xs text-muted-foreground">10–5,000 characters. Include the project, timing, and budget if known.</p></div>
        <div hidden aria-hidden="true"><label htmlFor="inquiry-website">Leave this field empty</label>
          <input id="inquiry-website" name="website" tabIndex={-1} autoComplete="off" value={fields.website} onChange={e => edit("website", e.target.value)} /></div>
        <div ref={challenge} aria-label="Spam protection verification" />
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3.5 text-xs leading-relaxed text-muted-foreground">
          <p>Submitting this form stores your name, email address, optional company, and collaboration proposal and makes them available to the intended creator for reviewing your proposal. A reply is not guaranteed.</p>
          <p>New inquiries follow a 180-day retention policy in CollabFlow&apos;s active database. Automatic deletion happens through scheduled cleanup after the 180-day retention deadline and may not occur at exactly 180 days.</p>
          <p>Spam protection is provided by Cloudflare Turnstile. Preparing verification contacts Cloudflare.</p>
        </div>
        <Button type="submit" disabled={!ready || pending}>{pending ? "Sending…" : token ? "Send inquiry" : "Prepare verification"}</Button>
      </fieldset>
      {feedback && <p ref={notice} tabIndex={-1} role="alert" className="text-sm">{feedback}</p>}
      <noscript>JavaScript is required for spam verification and inquiry submission.</noscript>
    </form>
  </section>;
}
