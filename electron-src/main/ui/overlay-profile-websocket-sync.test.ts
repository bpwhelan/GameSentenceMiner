import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("overlay GSM profile synchronization", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/main.js"),
    "utf8"
  );

  it("does not poll config.json for profile changes", () => {
    expect(source).not.toContain("fs.watchFile(gsmSettingsPath");
    expect(source).not.toContain("fs.unwatchFile(gsmSettingsPath");
  });

  it("requests profile reconciliation over the backend websocket", () => {
    expect(source).toContain('type: "get-gsm-profile-state"');
    expect(source).toMatch(/setInterval\(\(\) => \{[\s\S]*requestGSMProfileState/);
  });

  it("forwards pushed profile snapshots to the settings renderer", () => {
    expect(source).toContain('message.type === "gsm-profile-state-updated"');
    expect(source).toContain('webContents.send("overlay-profile-state-updated"');
  });
});
