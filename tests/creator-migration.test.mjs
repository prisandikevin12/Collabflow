import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RESERVED_SLUGS } from "../lib/creator/profile.ts";

const sql = readFileSync(new URL("../supabase/migrations/20261119000100_creator_profiles.sql", import.meta.url), "utf8");

test("application and migration reserve exactly the same slugs", () => {
  const list = sql.match(/slug not in \(([\s\S]*?)\)/)[1];
  const reserved = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(reserved.sort(), [...RESERVED_SLUGS].sort());
});

// Static guardrails complement, but do not replace, the executable RLS SQL.
test("migration retains restricted grants and owner-only RLS", () => {
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table public.creator_profiles from public, anon, authenticated/i);
  assert.match(sql, /grant insert \(user_id, display_name, slug, bio\)/i);
  assert.match(sql, /grant update \(display_name, slug, bio\)/i);
  assert.equal((sql.match(/create policy /gi) ?? []).length, 3);
  assert.equal((sql.match(/\(select auth.uid\(\)\) = user_id/g) ?? []).length, 4);
  assert.doesNotMatch(sql, /grant (?:all|delete)|to anon|security definer/i);
});
