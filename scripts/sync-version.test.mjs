import test from "node:test";
import assert from "node:assert/strict";

import { resolveProjectVersion } from "./sync-version-logic.mjs";

test("resolveProjectVersion preserves a matching Python post-release", () => {
  assert.equal(resolveProjectVersion("2026.8.2", "2026.8.2.post1"), "2026.8.2.post1");
  assert.equal(resolveProjectVersion("2026.8.2", "2026.8.2.post12"), "2026.8.2.post12");
});

test("resolveProjectVersion synchronizes exact and stale project versions", () => {
  assert.equal(resolveProjectVersion("2026.8.2", "2026.8.2"), "2026.8.2");
  assert.equal(resolveProjectVersion("2026.8.3", "2026.8.2.post1"), "2026.8.3");
  assert.equal(resolveProjectVersion("2026.8.3", "2026.8.3.dev1"), "2026.8.3");
});

test("resolveProjectVersion does not preserve invalid post-release numbers", () => {
  assert.equal(resolveProjectVersion("2026.8.2", "2026.8.2.post0"), "2026.8.2");
  assert.equal(resolveProjectVersion("2026.8.2", "2026.8.2.post01"), "2026.8.2");
});
