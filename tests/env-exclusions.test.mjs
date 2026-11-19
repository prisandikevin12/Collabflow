import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Git ignores environment variants while allowing placeholder examples", () => {
  // check-ignore examines rules and path names; it does not read these files.
  const ignored = [
    ".env", ".env.local", ".env.production", ".env.production.local",
    ".env.development", ".env.test", ".env.backup", ".envrc",
    "nested/.env", "nested/.env.local",
  ];
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    input: [...ignored, ".env.example", "nested/.env.example"].join("\n") + "\n",
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ignored);
});
