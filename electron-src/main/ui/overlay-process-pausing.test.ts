import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

function loadShouldOverlayHotkeyRequestPause(gsmSettings: any) {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/main.js"),
    "utf8"
  );
  const match = source.match(
    /function shouldOverlayHotkeyRequestPause\(source\) \{[\s\S]*?\n\}/
  );
  if (!match) {
    throw new Error("Unable to find shouldOverlayHotkeyRequestPause in GSM_Overlay/main.js");
  }

  const module = { exports: {} as any };
  const context = {
    module,
    getGSMSettings: () => gsmSettings,
    getCurrentGSMProfileSettings: (settings: any) => {
      const configs = settings?.configs ?? {};
      return configs[settings?.current_profile] ?? configs.Default ?? {};
    },
    OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY: "manual-hotkey",
    OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY: "texthooker-hotkey",
    OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION: "gamepad-navigation"
  };

  vm.runInNewContext(
    `${match[0]}\nmodule.exports = { shouldOverlayHotkeyRequestPause };`,
    context,
    { filename: "GSM_Overlay/main.js#shouldOverlayHotkeyRequestPause" }
  );

  return module.exports.shouldOverlayHotkeyRequestPause as (source: string) => boolean;
}

describe("overlay process pausing config gate", () => {
  it("reads process pausing from the active GSM profile without requiring global experimental features", () => {
    const shouldRequestPause = loadShouldOverlayHotkeyRequestPause({
      current_profile: "Game",
      experimental: { enable_experimental_features: false },
      configs: {
        Default: {
          process_pausing: {
            enabled: false,
            overlay_manual_hotkey_requests_pause: false,
            overlay_texthooker_hotkey_requests_pause: false,
            overlay_gamepad_navigation_requests_pause: false
          }
        },
        Game: {
          process_pausing: {
            enabled: true,
            overlay_manual_hotkey_requests_pause: true,
            overlay_texthooker_hotkey_requests_pause: true,
            overlay_gamepad_navigation_requests_pause: true
          }
        }
      }
    });

    expect(shouldRequestPause("manual-hotkey")).toBe(true);
    expect(shouldRequestPause("texthooker-hotkey")).toBe(true);
    expect(shouldRequestPause("gamepad-navigation")).toBe(true);
  });

  it("keeps legacy top-level process pausing as a fallback", () => {
    const shouldRequestPause = loadShouldOverlayHotkeyRequestPause({
      current_profile: "Default",
      process_pausing: {
        enabled: true,
        overlay_manual_hotkey_requests_pause: true
      },
      configs: {
        Default: {}
      }
    });

    expect(shouldRequestPause("manual-hotkey")).toBe(true);
    expect(shouldRequestPause("gamepad-navigation")).toBe(true);
  });
});
