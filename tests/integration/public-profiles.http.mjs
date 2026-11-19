import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Run after `npm run build`. All public database traffic goes to a local
// fixture; no hosted credentials, migrations, writes, or Auth accounts needed.
test("production HTTP public profiles and protected-route regressions", { timeout: 60000 }, async (t) => {
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
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${fixture.address().port}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-public-fixture-key" },
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
    for (const path of ["/dashboard", "/onboarding", "/protected", "/dashboard?private=secret", "/c/example/settings", "/c/example/photo.png", "/c", "/api/inquiries", "/creator-not-found", "/creator-unavailable"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 307, path);
      const target = new URL(response.headers.get("location"), base);
      assert.equal(target.pathname, "/auth/login"); assert.equal(target.search, "");
    }
  });
  await t.test("M1 public landing and authentication entry routes remain available", async () => {
    for (const path of ["/", "/auth/login", "/auth/sign-up", "/auth/forgot-password", "/auth/update-password", "/auth/sign-up-success", "/auth/error"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200, path);
      await response.text();
    }
  });
});
