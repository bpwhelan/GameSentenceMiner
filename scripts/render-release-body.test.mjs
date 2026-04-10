import test from "node:test";
import assert from "node:assert/strict";

import {
  renderPrereleaseBody,
  renderStableReleaseBody,
} from "./render-release-body.mjs";

test("renderStableReleaseBody includes only user-facing downloads", () => {
  const body = renderStableReleaseBody({
    repo: "bpwhelan/GameSentenceMiner",
    version: "2026.4.2",
  });

  assert.match(body, /\| Windows \| \[GameSentenceMiner-Setup-2026\.4\.2\.exe\]/);
  assert.match(body, /\| Linux \| \[GameSentenceMiner-2026\.4\.2\.AppImage\]/);
  assert.match(body, /\| macOS \(Apple Silicon\) \| \[GameSentenceMiner-2026\.4\.2-arm64\.dmg\]/);
  assert.doesNotMatch(body, /x64\.dmg/);
  assert.match(body, /Intel Mac builds are no longer provided\./);
});

test("renderPrereleaseBody warns users away from prereleases", () => {
  const body = renderPrereleaseBody({
    repo: "bpwhelan/GameSentenceMiner",
  });

  assert.match(body, /\*\*Development prerelease\*\*/);
  assert.match(body, /not the latest stable release/);
  assert.match(body, /should only be downloaded if you know what you are doing/);
  assert.match(
    body,
    /https:\/\/github\.com\/bpwhelan\/GameSentenceMiner\/releases\/latest/
  );
});
