import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

function loadLegacyGamepadHandler() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/gamepad.js"),
    "utf8"
  );

  const module = { exports: {} as any };
  const context = {
    module,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: {},
    CustomEvent: class CustomEvent {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
  };

  vm.runInNewContext(source, context, {
    filename: "GSM_Overlay/gamepad.js"
  });

  return module.exports;
}

const GamepadHandler = loadLegacyGamepadHandler();

describe("legacy gamepad button bindings", () => {
  it("normalizes legacy numeric buttons and human-readable combos", () => {
    expect(GamepadHandler.normalizeButtonBindingValue(8)).toMatchObject({
      buttons: [8],
      disabled: false,
      label: "Back"
    });

    expect(GamepadHandler.normalizeButtonBindingValue("LB + A")).toMatchObject({
      buttons: [4, 0],
      disabled: false,
      label: "LB + A"
    });

    expect(
      GamepadHandler.normalizeButtonBindingValue("Back/Select/View")
    ).toMatchObject({
      buttons: [8],
      disabled: false,
      label: "Back"
    });
  });

  it("keeps explicit disabled bindings while falling back from invalid ones", () => {
    expect(GamepadHandler.normalizeButtonBindingValue("Disabled", 4)).toMatchObject({
      buttons: [],
      disabled: true,
      label: "Disabled"
    });

    expect(
      GamepadHandler.normalizeButtonBindingValue("not-a-real-button", 4)
    ).toMatchObject({
      buttons: [4],
      disabled: false,
      label: "LB"
    });
  });

  it("matches held combos regardless of which combo button fired last", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      buttonStates: Map<string, Record<number, boolean>>;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, button: number) => boolean;
    };

    handler.buttonStates = new Map([["pad-1", { 0: true, 4: true }]]);

    const comboBinding = GamepadHandler.normalizeButtonBindingValue("LB + A");

    expect(handler.isButtonBindingHeld(comboBinding, "pad-1")).toBe(true);
    expect(handler.matchesButtonBindingDown(comboBinding, "pad-1", 0)).toBe(true);
    expect(handler.matchesButtonBindingDown(comboBinding, "pad-1", 4)).toBe(true);
    expect(handler.matchesButtonBindingDown(comboBinding, "pad-1", 5)).toBe(false);

    handler.buttonStates = new Map([["pad-1", { 4: true }]]);
    expect(handler.isButtonBindingHeld(comboBinding, "pad-1")).toBe(false);
  });
});

describe("legacy gamepad start block selection", () => {
  function createStartSelectionHandler(blocks: Array<{ area: number; text: string }>) {
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: Array<{ __area: number; textContent: string }>;
      blockHasSelectableCharacters: (block: { textContent: string }) => boolean;
      getBlockBoundingRect: (block: { __area: number }) => { width: number; height: number };
      getBlockSelectionMetrics: (block: { __area: number; textContent: string }) => { area: number; textLength: number };
      findFirstSelectableBlockIndex: () => number;
    };

    handler.textBlocks = blocks.map((block) => ({
      __area: block.area,
      textContent: block.text
    }));
    handler.blockHasSelectableCharacters = (block) => block.textContent.trim().length > 0;
    handler.getBlockBoundingRect = (block) => ({ width: block.__area, height: 1 });

    return handler;
  }

  it("prefers the dominant large block when one block is much larger than the rest", () => {
    const handler = createStartSelectionHandler([
      { area: 12, text: "small 1" },
      { area: 90, text: "big block" },
      { area: 15, text: "small 2" },
      { area: 10, text: "small 3" }
    ]);

    expect(handler.findFirstSelectableBlockIndex()).toBe(1);
  });

  it("keeps the first selectable block when sizes are similar", () => {
    const handler = createStartSelectionHandler([
      { area: 30, text: "first" },
      { area: 40, text: "second" },
      { area: 35, text: "third" }
    ]);

    expect(handler.findFirstSelectableBlockIndex()).toBe(0);
  });
});
