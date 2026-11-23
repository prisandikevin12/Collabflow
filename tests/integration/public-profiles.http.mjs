import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Run after `npm run build`. All public database traffic goes to a local
// fixture; no hosted credentials, migrations, writes, or Auth accounts needed.
for (const inquiriesEnabled of [false, true]) {
test(`production HTTP public profiles and protected routes (inquiries ${inquiriesEnabled ? "enabled" : "disabled"})`, { timeout: 60000 }, async (t) => {
  assert.equal(existsSync(new URL("../../.env.local", import.meta.url)), false,
    "Run HTTP tests in an isolated source copy without .env.local; Next loads environment files automatically.");
  const privateId = "11111111-1111-4111-8111-111111111111";
  let profile = { public_id: "55555555-5555-4555-8555-555555555555", slug: "public-creator", display_name: "Public Creator", bio: "A short public bio." };
  const requests = [];
  const fixture = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ path: url.pathname, select: url.searchParams.get("select"), slug: url.searchParams.get("slug") });
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    if (url.pathname !== "/rest/v1/creator_public_profiles") {
      res.writeHead(500); res.end(JSON.stringify({ message: "Unexpected private request" })); return;
    }
    await delay(40); // Ensure the normal Suspense route has time to stream.
    if (url.searchParams.get("slug") === "eq.database-failure") {
      res.writeHead(503); res.end(JSON.stringify({ message: "private upstream detail" })); return;
    }
    res.end(JSON.stringify(profile && url.searchParams.get("slug") === `eq.${profile.slug}`
      ? [{ ...profile, user_id: privateId, email: "private@example.test" }] : []));
  });
  fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const appPortServer = createServer(); appPortServer.listen(0, "127.0.0.1"); await once(appPortServer, "listening");
  const appPort = appPortServer.address().port;
  await new Promise(resolve => appPortServer.close(resolve));
  const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, INQUIRIES_ENABLED: String(inquiriesEnabled),
      TURNSTILE_SITE_KEY: "fixture-site-key", TURNSTILE_SECRET_KEY: "fixture-server-secret",
      INQUIRY_HMAC_SECRET: "fixture-hmac-secret-not-real-32-characters",
      INQUIRY_ALLOWED_ORIGINS: "https://collabflow.example", TURNSTILE_ALLOWED_HOSTNAMES: "collabflow.example",
      INQUIRY_DATABASE_URL: "", VERCEL: "1",
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${fixture.address().port}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-public-fixture-key" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  app.stdout.on("data", chunk => { output += chunk; });
  app.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (app.exitCode === null) { const exited = once(app, "exit"); app.kill(); await exited; }
  });
  const base = `http://127.0.0.1:${appPort}`;
  function assertUncached(response) {
    assert.match(response.headers.get("cache-control") ?? "", /(?:no-store|s-maxage=0)/);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (output.includes("Ready in")) break;
    if (app.exitCode !== null) throw new Error(`Next exited before startup: ${output}`);
    await delay(100);
  }
  assert.match(output, /Ready in/, "production server must start");

  await t.test("published HTML exposes approved information only", async () => {
    const response = await fetch(`${base}/c/public-creator`);
    assert.equal(response.status, 200);
    assertUncached(response);
    const html = await response.text();
    assert.match(html, /Public Creator/);
    assert.match(html, /A short public bio/);
    assert.ok(!html.includes(privateId));
    assert.ok(!html.includes("private@example.test"));
    assert.doesNotMatch(html, /fixture-server-secret|fixture-hmac-secret|collabflow_inquiry_writer/);
    if (inquiriesEnabled) {
      assert.match(html, /Propose a collaboration/);
      assert.match(html, /inquiry-email/);
      assert.match(html, /inquiry-message/);
      assert.match(html, /Prepare verification/);
      assert.match(html, /name, email address, optional company, and collaboration proposal/);
      assert.match(html, /available to the intended creator for reviewing your proposal/);
      assert.match(html, /180-day retention policy/);
      assert.match(html, /scheduled cleanup after the 180-day retention deadline and may not occur at exactly 180 days/);
      assert.match(html, /Cloudflare Turnstile/);
      assert.doesNotMatch(html, /backup retention policy|privacy policy/i);
      assert.doesNotMatch(html, /href="[^"]*(?:privacy|terms|policy)[^"]*"/i);
      assert.match(html, /fixture-site-key/);
    } else {
      assert.match(html, /Collaboration inquiries aren’t available yet\.|Collaboration inquiries aren&#x27;t available yet\./);
      assert.doesNotMatch(html, /Propose a collaboration|180-day retention policy|fixture-site-key/);
    }
    assert.ok(requests.length > 0, "fixture must receive the database lookup");
    assert.ok(requests.every(r => r.path === "/rest/v1/creator_public_profiles" && r.select === "public_id,slug,display_name,bio"));
  });
  await t.test("unknown, unpublished, and invalid slugs return actual HTTP 404", async () => {
    for (const slug of ["unknown-creator", "private-creator", "UPPERCASE", "ab", "bad--slug", "admin", "a".repeat(41), "encoded%2Fslash", "avatar.png", "%61bc", "bad%20slug"]) {
      const response = await fetch(`${base}/c/${slug}`, { redirect: "manual" });
      const html = await response.text();
      assert.equal(response.status, 404, `${slug} must return 404, not a streamed 200 (location: ${response.headers.get("location")}; url: ${response.url})`);
      assert.match(html, /Creator page not found/);
      assert.doesNotMatch(html, /private upstream detail/);
      assertUncached(response);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("x-robots-tag"), "noindex");
    }
  });
  await t.test("browser-supplied profile headers cannot forge or replace public content", async () => {
    const headers = { "x-collabflow-public-profile": encodeURIComponent(JSON.stringify({
      ...profile, display_name: "Forged Creator", bio: "Forged bio",
    })), cookie: "unrelated=browser-cookie" };
    let response = await fetch(`${base}/c/public-creator`, { headers, redirect: "manual" });
    assert.equal(response.status, 200);
    assertUncached(response);
    const html = await response.text();
    assert.match(html, /Public Creator/);
    assert.doesNotMatch(html, /Forged Creator|Forged bio/);
    response = await fetch(`${base}/c/private-creator`, { headers, redirect: "manual" });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /Forged Creator|Forged bio/);
  });
  await t.test("HEAD and React navigation requests retain missing-profile status", async () => {
    for (const slug of ["public-creator", "unknown-creator", "bad.png"]) {
      const response = await fetch(`${base}/c/${slug}`, { method: "HEAD", redirect: "manual" });
      assert.equal(response.status, slug === "public-creator" ? 200 : 404);
      assertUncached(response);
      assert.equal(await response.text(), "");
    }
    const response = await fetch(`${base}/c/unknown-creator?_rsc=fixture`, {
      headers: { RSC: "1", "Next-Router-Prefetch": "1" }, redirect: "manual",
    });
    assert.equal(response.status, 404);
    assertUncached(response);
  });
  await t.test("Unicode limits and HTML-like text render safely", async () => {
    const original = profile;
    profile = { ...profile, display_name: "😀".repeat(60), bio: "<script>alert(1)</script>" + "😀".repeat(250) };
    try {
      const response = await fetch(`${base}/c/public-creator`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
      assert.ok(html.includes(profile.display_name));
    } finally { profile = original; }
  });
  await t.test("edits, slug changes and unpublication do not leave cached public data", async () => {
    profile = { ...profile, display_name: "Updated Creator", slug: "renamed-creator", bio: null };
    let response = await fetch(`${base}/c/renamed-creator`, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Updated Creator/);
    response = await fetch(`${base}/c/public-creator`, { redirect: "manual" });
    assert.equal(response.status, 404);
    profile = null;
    response = await fetch(`${base}/c/renamed-creator`, { redirect: "manual" });
    assert.equal(response.status, 404);
    assertUncached(response);
    assert.doesNotMatch(await response.text(), /Updated Creator|A short public bio/);
  });
  await t.test("database errors return availability errors, not false 404s or private details", async () => {
    const response = await fetch(`${base}/c/database-failure`, { redirect: "manual" });
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.match(html, /Creator page temporarily unavailable/);
    assert.doesNotMatch(html, /private upstream detail/);
    assertUncached(response);
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
  });
  await t.test("signed-out dashboard, onboarding, legacy and nested routes remain protected", async () => {
    const privatePaths = new Set([
      "/dashboard",
      "/dashboard/inquiries",
      "/dashboard/inquiries/aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      "/onboarding",
      "/protected",
      "/dashboard?private=secret",
    ]);
    for (const path of ["/dashboard", "/dashboard/inquiries", "/dashboard/inquiries/aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "/onboarding", "/protected", "/dashboard?private=secret", "/c/example/settings", "/c/example/photo.png", "/c", "/api/inquiries/private", "/api/inquiries-extra", "/creator-not-found", "/creator-unavailable"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 307, path);
      const target = new URL(response.headers.get("location"), base);
      assert.equal(target.pathname, "/auth/login"); assert.equal(target.search, "");
      if (privatePaths.has(path)) {
        assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0", path);
        assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", path);
      }
    }
  });
  await t.test("M1 public landing and authentication entry routes remain available", async () => {
    for (const path of ["/", "/auth/login", "/auth/sign-up", "/auth/forgot-password", "/auth/update-password", "/auth/sign-up-success", "/auth/error"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200, path);
      await response.text();
    }
  });
  await t.test("auth error page never reflects arbitrary query parameters and links back to login", async () => {
    for (const query of [
      "",
      "?error=Your+account+is+locked+call+555-0199",
      "?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      "?error=confirm_failed&error=extra",
      "?error=toString",
    ]) {
      const response = await fetch(`${base}/auth/error${query}`, { redirect: "manual" });
      assert.equal(response.status, 200, query);
      const html = await response.text();
      // Exclude Next's internal router URL flight script; verify visible DOM markup only.
      const visibleHtml = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
      assert.match(visibleHtml, /<p role="alert"[^>]*>We couldn’t complete your authentication request\. Please sign in or request a new link\.<\/p>/);
      assert.doesNotMatch(visibleHtml, /Code error:|555-0199|alert\(1\)|toString/);
      assert.match(visibleHtml, /href="\/auth\/login"/);
    }
    const confirmFailed = await fetch(`${base}/auth/error?error=confirm_failed`, { redirect: "manual" });
    assert.equal(confirmFailed.status, 200);
    assert.match(
      (await confirmFailed.text()).replace(/<script\b[\s\S]*?<\/script>/gi, ""),
      /<p role="alert"[^>]*>Unable to confirm this link\. Please request a new one\.<\/p>/,
    );

    const invalidLink = await fetch(`${base}/auth/error?error=invalid_link`, { redirect: "manual" });
    assert.equal(invalidLink.status, 200);
    assert.match(
      (await invalidLink.text()).replace(/<script\b[\s\S]*?<\/script>/gi, ""),
      /<p role="alert"[^>]*>Invalid confirmation link\. Please request a new one\.<\/p>/,
    );

    const confirmRedirect = await fetch(`${base}/auth/confirm`, { redirect: "manual" });
    assert.equal(confirmRedirect.status, 307);
    const target = new URL(confirmRedirect.headers.get("location"), base);
    assert.equal(target.pathname, "/auth/error");
    assert.equal(target.search, "?error=invalid_link");
  });
  await t.test("inquiry endpoint enforces feature flag and non-POST requests cannot read data", async () => {
    for (const extraHeaders of [{}, { cookie: "ordinary=cookie; sb-127-auth-token=forged" }]) {
      const response = await fetch(`${base}/api/inquiries`, { method: "POST", headers: extraHeaders, redirect: "manual", body: "{}" });
      assert.equal(response.status, inquiriesEnabled ? 403 : 404);
      assert.equal(response.headers.get("location"), null);
      assertUncached(response);
    }
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const rejected = await fetch(`${base}/api/inquiries`, { method, redirect: "manual" });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get("allow"), "POST");
      assertUncached(rejected);
      assert.equal(await rejected.text(), "");
    }
  });
  if (inquiriesEnabled) await t.test("production inquiry route fails closed before external calls", async () => {
    const headers = { origin: "https://collabflow.example", "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.1" };
    const data = { creatorPublicId: "55555555-5555-4555-8555-555555555555", creatorSlug: "public-creator",
      submissionId: "66666666-6666-4666-8666-666666666666", senderName: "Alice", senderEmail: "alice@example.test",
      company: "", message: "A collaboration proposal.", website: "", turnstileToken: "fixture-token" };
    for (const [body, overrides, status] of [
      ["{", {}, 400],
      [JSON.stringify(data), { origin: "https://attacker.example" }, 403],
      [JSON.stringify(data), { origin: "https://attacker.example", cookie: "ordinary=cookie" }, 403],
      [JSON.stringify(data), { "x-vercel-forwarded-for": "", "x-forwarded-for": "203.0.113.1" }, 503],
      [JSON.stringify({ ...data, website: "bot.example" }), {}, 400],
      [JSON.stringify({ ...data, owner_id: privateId }), {}, 400],
      [JSON.stringify(data), { "sec-fetch-site": "same-origin" }, 503], // Anonymous POST reaches fail-closed DB boundary, never 401/307.
      [JSON.stringify(data), { "sec-fetch-site": "same-origin", cookie: "ordinary=cookie; sb-127-auth-token=forged" }, 503], // Same-origin cookies preserve validation and never create session cookies.
    ]) {
      const response = await fetch(`${base}/api/inquiries`, { method: "POST", headers: { ...headers, ...overrides }, body, redirect: "manual" });
      assert.equal(response.status, status);
      assertUncached(response);
      assert.equal(response.headers.get("location"), null);
      assert.doesNotMatch(await response.text(), /fixture-token|alice@example|fixture-server-secret|postgres|INQUIRY_DATABASE_URL/);
    }
  });
});
}
