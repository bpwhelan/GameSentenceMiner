import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

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
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      elementFromPoint: () => null
    },
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

  return {
    GamepadHandler: module.exports,
    context
  };
}

function loadStartupGamepadSettings(settings: Record<string, unknown>) {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/index.html"),
    "utf8"
  );
  const start = source.indexOf("    // Load gamepad settings");
  const end = source.indexOf("    // Apply hide furigana on startup", start);
  if (start < 0 || end < 0) {
    throw new Error("Unable to find startup gamepad settings in GSM_Overlay/index.html");
  }

  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(
    [
      `const newsettings = ${JSON.stringify(settings)};`,
      "const gamepadSettings = { enabled: true };",
      "const KEYBOARD_SETTING_KEYS = [];",
      source.slice(start, end),
      "module.exports = gamepadSettings;"
    ].join("\n"),
    { module },
    { filename: "GSM_Overlay/index.html#startup-gamepad-settings" }
  );

  return module.exports;
}

const legacyGamepad = loadLegacyGamepadHandler();
const GamepadHandler = legacyGamepad.GamepadHandler;
const legacyGamepadContext = legacyGamepad.context;

describe("legacy gamepad startup settings", () => {
  it("honors a disabled master gamepad setting before initialization", () => {
    expect(loadStartupGamepadSettings({ gamepadEnabled: false })).toMatchObject({
      enabled: false
    });
  });
});

describe("legacy gamepad toggle debouncing", () => {
  it("ignores a second navigation toggle during a Steam input-mode handoff", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      toggleModeActive: boolean;
      lastToggleActionTimes: Map<string, number>;
      activateNavigation: ReturnType<typeof vi.fn>;
      deactivateNavigation: ReturnType<typeof vi.fn>;
      getToggleTimestamp: ReturnType<typeof vi.fn>;
      toggleNavigationMode: () => boolean;
    };
    handler.toggleModeActive = false;
    handler.lastToggleActionTimes = new Map();
    handler.activateNavigation = vi.fn();
    handler.deactivateNavigation = vi.fn();
    handler.getToggleTimestamp = vi.fn()
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1400)
      .mockReturnValueOnce(1450)
      .mockReturnValueOnce(1700)
      .mockReturnValueOnce(1700);

    expect(handler.toggleNavigationMode()).toBe(true);
    expect(handler.toggleNavigationMode()).toBe(false);

    expect(handler.toggleModeActive).toBe(true);
    expect(handler.activateNavigation).toHaveBeenCalledTimes(1);
    expect(handler.deactivateNavigation).not.toHaveBeenCalled();

    expect(handler.toggleNavigationMode()).toBe(true);
    expect(handler.toggleModeActive).toBe(false);
    expect(handler.deactivateNavigation).toHaveBeenCalledTimes(1);
  });
});

describe("legacy gamepad Sudachi requests", () => {
  it("includes the configured dictionary in tokenization requests", () => {
    const sent: unknown[] = [];
    const handler = Object.create(GamepadHandler.prototype) as {
      config: { sudachiDictionary: string };
      wsConnected: boolean;
      ws: { send: (payload: string) => void };
      sudachiAvailable: boolean;
      mecabAvailable: boolean;
    };
    handler.config = { sudachiDictionary: "small" };
    handler.wsConnected = true;
    handler.ws = { send: (payload) => sent.push(JSON.parse(payload)) };
    handler.sudachiAvailable = true;
    handler.mecabAvailable = false;

    GamepadHandler.prototype.requestTokenizationFromServer.call(
      handler,
      2,
      "食べた。",
      "sudachi"
    );

    expect(sent).toEqual([
      {
        type: "tokenize",
        blockIndex: 2,
        text: "食べた。",
        backend: "sudachi",
        dictionary: "small"
      }
    ]);
  });
});

describe("legacy gamepad token refreshes", () => {
  it("does not trigger a lookup when refreshed text finishes tokenizing", () => {
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.pendingTokenizationByBlock = new Map([[0, true]]);
    handler.tokenCacheByBlock = new Map();
    handler.currentBlockIndex = 0;
    handler.currentCursorIndex = 1;
    handler.tokens = [];
    handler.tokensBlockIndex = -1;
    handler.tokenMode = true;
    handler.getBlockText = () => "日本語";
    handler.shouldTokenizeText = () => true;
    handler.isNavigationActive = () => true;
    handler.syncSelectionFromVirtualMouse = () => false;
    handler.getCurrentAnchorCharIndex = () => 1;
    handler.charIndexToTokenIndex = () => 0;
    handler.getLineIndexForCursor = () => 0;
    handler.updateVisuals = vi.fn();
    handler.positionCursorAtToken = vi.fn();
    handler.syncVirtualMouseToCurrentSelection = vi.fn();
    handler.autoConfirmSelection = vi.fn();
    handler.updateModeIndicatorText = vi.fn();

    handler.onTokensReceived({
      blockIndex: 0,
      text: "日本語",
      tokens: [{ word: "日本語", start: 0, end: 3 }]
    });

    expect(handler.currentCursorIndex).toBe(0);
    expect(handler.positionCursorAtToken).not.toHaveBeenCalled();
    expect(handler.syncVirtualMouseToCurrentSelection).toHaveBeenCalledTimes(1);
    expect(handler.autoConfirmSelection).not.toHaveBeenCalled();
  });

  it("suppresses lookup when refreshed tokens resync the virtual cursor", () => {
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.pendingTokenizationByBlock = new Map([[0, true]]);
    handler.tokenCacheByBlock = new Map();
    handler.currentBlockIndex = 0;
    handler.tokens = [];
    handler.tokensBlockIndex = -1;
    handler.tokenMode = true;
    handler.getBlockText = () => "日本語";
    handler.shouldTokenizeText = () => true;
    handler.isNavigationActive = () => true;
    handler.autoConfirmSelection = vi.fn();
    handler.syncSelectionFromVirtualMouse = vi.fn(
      (_sourceElement: unknown, options: { autoConfirm?: boolean } = {}) => {
        if (options.autoConfirm !== false) {
          handler.autoConfirmSelection();
        }
        return true;
      }
    );
    handler.syncVirtualMouseToCurrentSelection = vi.fn();
    handler.updateModeIndicatorText = vi.fn();

    handler.onTokensReceived({
      blockIndex: 0,
      text: "日本語",
      tokens: [{ word: "日本語", start: 0, end: 3 }]
    });

    expect(handler.syncSelectionFromVirtualMouse).toHaveBeenCalledWith(
      null,
      { autoConfirm: false }
    );
    expect(handler.syncVirtualMouseToCurrentSelection).toHaveBeenCalledTimes(1);
    expect(handler.autoConfirmSelection).not.toHaveBeenCalled();
  });

  it("confirms the current selection when navigation enters with tokenization pending", () => {
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.pendingTokenizationByBlock = new Map([[0, "日本語"]]);
    handler.pendingTokenizationStartedWhileNavigationActive = new Map([[0, false]]);
    handler.tokenCacheByBlock = new Map();
    handler.currentBlockIndex = 0;
    handler.tokens = [];
    handler.tokensBlockIndex = -1;
    handler.tokenMode = true;
    handler.getBlockText = () => "日本語";
    handler.shouldTokenizeText = () => true;
    handler.isNavigationActive = () => true;
    handler.syncSelectionFromVirtualMouse = vi.fn(() => false);
    handler.getCurrentAnchorCharIndex = () => 1;
    handler.charIndexToTokenIndex = () => 0;
    handler.getLineIndexForCursor = () => 0;
    handler.updateVisuals = vi.fn();
    handler.syncVirtualMouseToCurrentSelection = vi.fn();
    handler.autoConfirmSelection = vi.fn();
    handler.updateModeIndicatorText = vi.fn();

    handler.onTokensReceived({
      blockIndex: 0,
      text: "日本語",
      tokens: [{ word: "日本語", start: 0, end: 3 }]
    });

    expect(handler.syncVirtualMouseToCurrentSelection).toHaveBeenCalledTimes(1);
    expect(handler.autoConfirmSelection).toHaveBeenCalledTimes(1);
  });
});

describe("legacy gamepad analog lookup path", () => {
  it("does not emit synthetic mouse events during virtual cursor movement", () => {
    const targetElement = {};
    const previousElementFromPoint = legacyGamepadContext.document.elementFromPoint;
    legacyGamepadContext.document.elementFromPoint = () => targetElement;

    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.virtualMouse = {
      x: 0,
      y: 0,
      initialized: false,
      movedByAnalog: true,
      lastMoveTime: 0,
      lastUpdateTime: 0
    };
    handler.getVirtualMouseConstraintRects = () => [];
    handler.updateVirtualMouseCursor = vi.fn();
    handler.simulateMousePosition = vi.fn();
    handler.syncSelectionFromVirtualMouse = vi.fn();

    try {
      GamepadHandler.prototype.setVirtualMousePosition.call(handler, 120, 80, true);
    } finally {
      legacyGamepadContext.document.elementFromPoint = previousElementFromPoint;
    }

    expect(handler.simulateMousePosition).not.toHaveBeenCalled();
    expect(handler.syncSelectionFromVirtualMouse).toHaveBeenCalledWith(targetElement);
  });

  it("does not arm a delayed hide when autoconfirm replaces the lookup", () => {
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.config = {
      autoConfirmSelection: true,
      navigationHideDelay: 200
    };
    handler.navigationAwayHideToken = 0;
    handler.navigationAwayHideTimer = null;

    try {
      GamepadHandler.prototype.scheduleHideYomitanAfterLeavingAnchor.call(handler, "0:0");
      expect(handler.navigationAwayHideTimer).toBeNull();
    } finally {
      if (handler.navigationAwayHideTimer) {
        clearTimeout(handler.navigationAwayHideTimer);
      }
    }
  });
});

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

  it("uses normalized bindings for Yomitan entry navigation buttons saved as labels", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      config: {
        activationMode: string;
        controllerEnabled: boolean;
        nextEntryButton: string;
        prevEntryButton: string;
      };
      buttonStates: Map<string, Record<number, boolean>>;
      buttonBindings: Record<string, any>;
      bindingContainsButton: (binding: any, buttonIndex: number) => boolean;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, buttonIndex: number) => boolean;
      refreshButtonBindings: () => void;
      onButtonDown: (buttonIndex: number, device: string) => void;
      yomitanPopupVisible: boolean;
      isNavigationActive: () => boolean;
      shouldProcessNavigation: () => boolean;
      navigateYomitanNextEntry: () => void;
      navigateYomitanPrevEntry: () => void;
    };

    handler.config = {
      activationMode: "modifier",
      controllerEnabled: true,
      nextEntryButton: "RT",
      prevEntryButton: "LT"
    };
    handler.buttonStates = new Map([["pad-1", { 7: true }]]);
    handler.bindingContainsButton = GamepadHandler.prototype.bindingContainsButton;
    handler.isButtonBindingHeld = GamepadHandler.prototype.isButtonBindingHeld;
    handler.matchesButtonBindingDown = GamepadHandler.prototype.matchesButtonBindingDown;
    handler.refreshButtonBindings = GamepadHandler.prototype.refreshButtonBindings;
    handler.onButtonDown = GamepadHandler.prototype.onButtonDown;
    handler.yomitanPopupVisible = true;
    handler.isNavigationActive = () => false;
    handler.shouldProcessNavigation = () => false;

    const calls: string[] = [];
    handler.navigateYomitanNextEntry = () => {
      calls.push("next");
    };
    handler.navigateYomitanPrevEntry = () => {
      calls.push("prev");
    };

    handler.refreshButtonBindings();

    expect(handler.buttonBindings.nextEntryButton).toMatchObject({
      buttons: [7],
      disabled: false,
      label: "RT"
    });
    expect(handler.buttonBindings.prevEntryButton).toMatchObject({
      buttons: [6],
      disabled: false,
      label: "LT"
    });

    handler.onButtonDown(7, "pad-1");
    handler.buttonStates = new Map([["pad-1", { 6: true }]]);
    handler.onButtonDown(6, "pad-1");

    expect(calls).toEqual(["next", "prev"]);
  });

  it("uses configurable controller bindings for token toggle and mining", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      config: {
        activationMode: string;
        controllerEnabled: boolean;
        confirmButton: string;
        tokenModeToggleButton: string;
        mineButton: string;
      };
      buttonStates: Map<string, Record<number, boolean>>;
      buttonBindings: Record<string, any>;
      bindingContainsButton: (binding: any, buttonIndex: number) => boolean;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, buttonIndex: number) => boolean;
      areButtonBindingsEquivalent: (left: any, right: any) => boolean;
      refreshButtonBindings: () => void;
      onButtonDown: (buttonIndex: number, device: string) => void;
      yomitanPopupVisible: boolean;
      isNavigationActive: () => boolean;
      shouldProcessNavigation: () => boolean;
      confirmSelection: () => void;
      cancelSelection: () => void;
      toggleTokenMode: () => void;
      triggerMining: () => void;
    };

    handler.config = {
      activationMode: "modifier",
      controllerEnabled: true,
      confirmButton: "A",
      tokenModeToggleButton: "Y",
      mineButton: "X"
    };
    handler.buttonStates = new Map([["pad-1", { 3: true }]]);
    handler.bindingContainsButton = GamepadHandler.prototype.bindingContainsButton;
    handler.isButtonBindingHeld = GamepadHandler.prototype.isButtonBindingHeld;
    handler.matchesButtonBindingDown = GamepadHandler.prototype.matchesButtonBindingDown;
    handler.areButtonBindingsEquivalent = GamepadHandler.prototype.areButtonBindingsEquivalent;
    handler.refreshButtonBindings = GamepadHandler.prototype.refreshButtonBindings;
    handler.onButtonDown = GamepadHandler.prototype.onButtonDown;
    handler.yomitanPopupVisible = false;
    handler.isNavigationActive = () => true;
    handler.shouldProcessNavigation = () => false;

    const calls: string[] = [];
    handler.confirmSelection = () => {
      calls.push("confirm");
    };
    handler.cancelSelection = () => {
      calls.push("cancel");
    };
    handler.toggleTokenMode = () => {
      calls.push("token-toggle");
    };
    handler.triggerMining = () => {
      calls.push("mine");
    };

    handler.refreshButtonBindings();

    expect(handler.buttonBindings.tokenModeToggleButton).toMatchObject({
      buttons: [3],
      disabled: false,
      label: "Y"
    });
    expect(handler.buttonBindings.mineButton).toMatchObject({
      buttons: [2],
      disabled: false,
      label: "X"
    });

    handler.onButtonDown(3, "pad-1");
    handler.buttonStates = new Map([["pad-1", { 2: true }]]);
    handler.onButtonDown(2, "pad-1");

    expect(calls).toEqual(["token-toggle", "mine"]);
  });

  it("preserves confirm behavior when mine and confirm share the default A button", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      config: {
        activationMode: string;
        controllerEnabled: boolean;
        confirmButton: number;
        mineButton: number;
      };
      buttonStates: Map<string, Record<number, boolean>>;
      buttonBindings: Record<string, any>;
      bindingContainsButton: (binding: any, buttonIndex: number) => boolean;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, buttonIndex: number) => boolean;
      areButtonBindingsEquivalent: (left: any, right: any) => boolean;
      refreshButtonBindings: () => void;
      onButtonDown: (buttonIndex: number, device: string) => void;
      yomitanPopupVisible: boolean;
      isNavigationActive: () => boolean;
      shouldProcessNavigation: () => boolean;
      confirmSelection: () => void;
      cancelSelection: () => void;
      toggleTokenMode: () => void;
      triggerMining: () => void;
    };

    handler.config = {
      activationMode: "modifier",
      controllerEnabled: true,
      confirmButton: 0,
      mineButton: 0
    };
    handler.buttonStates = new Map([["pad-1", { 0: true }]]);
    handler.bindingContainsButton = GamepadHandler.prototype.bindingContainsButton;
    handler.isButtonBindingHeld = GamepadHandler.prototype.isButtonBindingHeld;
    handler.matchesButtonBindingDown = GamepadHandler.prototype.matchesButtonBindingDown;
    handler.areButtonBindingsEquivalent = GamepadHandler.prototype.areButtonBindingsEquivalent;
    handler.refreshButtonBindings = GamepadHandler.prototype.refreshButtonBindings;
    handler.onButtonDown = GamepadHandler.prototype.onButtonDown;
    handler.yomitanPopupVisible = false;
    handler.isNavigationActive = () => true;
    handler.shouldProcessNavigation = () => false;

    const calls: string[] = [];
    handler.confirmSelection = () => {
      calls.push("confirm");
    };
    handler.cancelSelection = () => {
      calls.push("cancel");
    };
    handler.toggleTokenMode = () => {
      calls.push("token-toggle");
    };
    handler.triggerMining = () => {
      calls.push("mine");
    };

    handler.refreshButtonBindings();
    handler.onButtonDown(0, "pad-1");

    expect(calls).toEqual(["confirm"]);
  });
});

describe("legacy gamepad start block selection", () => {
  function createStartSelectionHandler(
    blocks: Array<{ area: number; text: string; role?: string }>
  ) {
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: Array<{
        __area: number;
        textContent: string;
        dataset: { blockRole?: string };
      }>;
      blockHasSelectableCharacters: (block: { textContent: string }) => boolean;
      getBlockBoundingRect: (block: { __area: number }) => { width: number; height: number };
      getBlockSelectionMetrics: (block: { __area: number; textContent: string }) => { area: number; textLength: number };
      findFirstSelectableBlockIndex: () => number;
    };

    handler.textBlocks = blocks.map((block) => ({
      __area: block.area,
      textContent: block.text,
      dataset: { blockRole: block.role }
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

  it("starts on dialogue instead of a preceding character-name block", () => {
    const handler = createStartSelectionHandler([
      { area: 12, text: "エステル", role: "character-name" },
      { area: 70, text: "ってことは、この向こう側はもうリベールじゃないんだ……", role: "dialogue" }
    ]);

    expect(handler.findFirstSelectableBlockIndex()).toBe(1);
  });

  it("still allows a character-name block when it is the only selectable block", () => {
    const handler = createStartSelectionHandler([
      { area: 12, text: "エステル", role: "character-name" }
    ]);

    expect(handler.findFirstSelectableBlockIndex()).toBe(0);
  });
});

describe("legacy gamepad block redraw recovery", () => {
  it("prefers a nearby prior block over the dominant large block after redraw", () => {
    const blocks = [
      {
        textContent: "big block",
        isConnected: true,
        querySelectorAll: () => [{ textContent: "big", dataset: {}, getClientRects: () => [1] }]
      },
      {
        textContent: "nearby old block",
        isConnected: true,
        querySelectorAll: () => [{ textContent: "near", dataset: {}, getClientRects: () => [1] }]
      },
      {
        textContent: "small block",
        isConnected: true,
        querySelectorAll: () => [{ textContent: "small", dataset: {}, getClientRects: () => [1] }]
      }
    ];

    legacyGamepadContext.document.querySelectorAll = (selector: string) =>
      selector === ".text-block-container" ? blocks : [];

    const handler = Object.create(GamepadHandler.prototype) as {
      lastSelectionSnapshot: {
        rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
        relativeX: number;
        relativeY: number;
      };
      textBlocks: typeof blocks;
      tokenCacheByBlock: Map<number, unknown>;
      pendingTokenizationByBlock: Map<number, unknown>;
      currentBlockIndex: number;
      currentCursorIndex: number;
      currentLineIndex: number;
      lineNavPrefersCharacters: boolean;
      characters: Array<unknown>;
      lines: Array<unknown>;
      tokens: Array<unknown>;
      tokensBlockIndex: number;
      isElementVisible: (block: unknown) => boolean;
      isTextBoxSelectable: (box: { textContent?: string }) => boolean;
      getBlockBoundingRect: (block: (typeof blocks)[number]) => {
        left: number;
        top: number;
        width: number;
        height: number;
      };
      getBlockSelectionMetrics: (block: (typeof blocks)[number]) => { area: number; textLength: number };
      refreshCharacters: () => void;
      findFirstSelectableBlockIndex: () => number;
      findNearbySelectableBlockIndex: (snapshot?: unknown) => number;
      restoreCursorFromSelectionSnapshot: (snapshot?: unknown) => number;
      getLineIndexForCursor: () => number;
      rememberCurrentSelectionSnapshot: () => unknown;
      refreshTextBlocks: () => void;
    };

    const rects = new Map([
      [blocks[0], { left: 300, top: 20, width: 400, height: 220 }],
      [blocks[1], { left: 18, top: 16, width: 120, height: 30 }],
      [blocks[2], { left: 25, top: 200, width: 120, height: 30 }]
    ]);

    handler.lastSelectionSnapshot = {
      rect: { left: 20, top: 20, right: 140, bottom: 50, width: 120, height: 30 },
      relativeX: 0.5,
      relativeY: 0.5
    };
    handler.textBlocks = [];
    handler.tokenCacheByBlock = new Map();
    handler.pendingTokenizationByBlock = new Map();
    handler.currentBlockIndex = 7;
    handler.currentCursorIndex = 0;
    handler.currentLineIndex = 0;
    handler.lineNavPrefersCharacters = false;
    handler.characters = [];
    handler.lines = [];
    handler.tokens = [];
    handler.tokensBlockIndex = -1;
    handler.isElementVisible = () => true;
    handler.isTextBoxSelectable = (box) => Boolean(box.textContent?.trim());
    handler.getBlockBoundingRect = (block) => rects.get(block)!;
    handler.refreshCharacters = function refreshCharacters() {
      this.characters = [{ isConnected: true }, { isConnected: true }, { isConnected: true }];
    };
    handler.getLineIndexForCursor = () => 0;
    handler.rememberCurrentSelectionSnapshot = () => null;
    handler.findFirstSelectableBlockIndex = GamepadHandler.prototype.findFirstSelectableBlockIndex;
    handler.findNearbySelectableBlockIndex = GamepadHandler.prototype.findNearbySelectableBlockIndex;
    handler.restoreCursorFromSelectionSnapshot = () => 2;

    handler.refreshTextBlocks();

    expect(handler.currentBlockIndex).toBe(1);
    expect(handler.currentCursorIndex).toBe(2);
  });

  it("restores the nearest navigable unit to the prior relative position", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: Array<{ isConnected: boolean }>;
      currentBlockIndex: number;
      findFirstNavigableUnitIndex: (direction?: number) => number;
      getBlockBoundingRect: () => { left: number; top: number; width: number; height: number };
      getNavigableUnitIndices: () => number[];
      getNavigationUnitCount: () => number;
      getNavigationUnitCenter: (index: number) => { x: number; y: number } | null;
      findClosestNavigableUnitToPoint: (x: number, y: number) => number | null;
      restoreCursorFromSelectionSnapshot: (snapshot: {
        rect: { width: number; height: number };
        relativeX: number;
        relativeY: number;
      }) => number;
    };

    handler.textBlocks = [{ isConnected: true }];
    handler.currentBlockIndex = 0;
    handler.findFirstNavigableUnitIndex = () => 0;
    handler.getBlockBoundingRect = () => ({ left: 100, top: 200, width: 200, height: 100 });
    handler.getNavigableUnitIndices = () => [0, 1, 2];
    handler.getNavigationUnitCount = () => 3;
    handler.getNavigationUnitCenter = (index) => (
      [
        { x: 120, y: 220 },
        { x: 210, y: 250 },
        { x: 280, y: 280 }
      ][index] ?? null
    );
    handler.findClosestNavigableUnitToPoint = GamepadHandler.prototype.findClosestNavigableUnitToPoint;

    const restoredIndex = GamepadHandler.prototype.restoreCursorFromSelectionSnapshot.call(handler, {
      rect: { width: 100, height: 50 },
      relativeX: 0.55,
      relativeY: 0.52
    });

    expect(restoredIndex).toBe(1);
  });

  it("preserves the current selection when overlay text render completes", () => {
    const calls: string[] = [];
    const snapshot = {
      rect: { left: 20, top: 20, right: 140, bottom: 50, width: 120, height: 30 },
      relativeX: 0.6,
      relativeY: 0.5
    };
    const handler = Object.create(GamepadHandler.prototype) as {
      lastSelectionSnapshot: typeof snapshot | null;
      skipNextTextRefresh: boolean;
      preserveSelectionOnNextTextRefresh: boolean;
      virtualMouse: { movedByAnalog: boolean; lastMoveTime: number };
      currentBlockIndex: number;
      currentCursorIndex: number;
      isNavigationActive: () => boolean;
      updateVirtualMouseCursor: () => void;
      refreshTextBlocks: () => void;
      restoreSelectionFromSnapshot: (snapshot: typeof snapshot) => boolean;
      prefetchTokenizationForAllBlocks: () => void;
      updateVisuals: () => void;
      handleOverlayTextRenderComplete: (options: { snapshot: typeof snapshot; preserveSelection: boolean }) => void;
    };

    handler.lastSelectionSnapshot = null;
    handler.skipNextTextRefresh = false;
    handler.preserveSelectionOnNextTextRefresh = false;
    handler.virtualMouse = { movedByAnalog: true, lastMoveTime: 123 };
    handler.currentBlockIndex = 0;
    handler.currentCursorIndex = 0;
    handler.isNavigationActive = () => true;
    handler.updateVirtualMouseCursor = () => calls.push("virtual");
    handler.refreshTextBlocks = () => calls.push("refresh");
    handler.restoreSelectionFromSnapshot = () => {
      calls.push("restore");
      handler.currentBlockIndex = 1;
      handler.currentCursorIndex = 3;
      return true;
    };
    handler.prefetchTokenizationForAllBlocks = () => calls.push("prefetch");
    handler.updateVisuals = () => calls.push("visuals");

    GamepadHandler.prototype.handleOverlayTextRenderComplete.call(handler, {
      snapshot,
      preserveSelection: true
    });

    expect(handler.lastSelectionSnapshot).toBe(snapshot);
    expect(handler.skipNextTextRefresh).toBe(true);
    expect(handler.preserveSelectionOnNextTextRefresh).toBe(true);
    expect(handler.virtualMouse).toMatchObject({ movedByAnalog: false, lastMoveTime: 0 });
    expect(handler.currentBlockIndex).toBe(1);
    expect(handler.currentCursorIndex).toBe(3);
    expect(calls).toEqual(["virtual", "refresh", "restore", "prefetch", "visuals"]);
  });

  it("clamps virtual mouse points to the only selectable block", () => {
    const block = { isConnected: true };
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: Array<typeof block>;
      currentBlockIndex: number;
      blockHasSelectableCharacters: () => boolean;
      getBlockBoundingRect: () => {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };
      constrainVirtualMousePointToBlocks: (x: number, y: number) => {
        x: number;
        y: number;
        block: typeof block | null;
        blockIndex: number;
        constrained: boolean;
      };
    };

    handler.textBlocks = [block];
    handler.currentBlockIndex = 0;
    handler.blockHasSelectableCharacters = () => true;
    handler.getBlockBoundingRect = () => ({
      left: 100,
      top: 50,
      right: 220,
      bottom: 110,
      width: 120,
      height: 60
    });

    const clamped = handler.constrainVirtualMousePointToBlocks(500, 10);
    expect(clamped).toMatchObject({ x: 220, y: 50, blockIndex: 0, constrained: true });
    expect(clamped.block).toBe(block);

    const inside = handler.constrainVirtualMousePointToBlocks(160, 75);
    expect(inside).toMatchObject({ x: 160, y: 75, blockIndex: 0, constrained: false });
    expect(inside.block).toBe(block);
  });

  it("allows virtual mouse points to move freely between selectable blocks", () => {
    const blocks = [{ isConnected: true }, { isConnected: true }];
    const rects = new Map([
      [blocks[0], { left: 0, top: 0, right: 100, bottom: 60, width: 100, height: 60 }],
      [blocks[1], { left: 220, top: 0, right: 320, bottom: 60, width: 100, height: 60 }]
    ]);
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: typeof blocks;
      currentBlockIndex: number;
      blockHasSelectableCharacters: () => boolean;
      getBlockBoundingRect: (block: (typeof blocks)[number]) => {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };
      constrainVirtualMousePointToBlocks: (x: number, y: number) => {
        x: number;
        y: number;
        block: (typeof blocks)[number] | null;
        blockIndex: number;
        constrained: boolean;
      };
    };

    handler.textBlocks = blocks;
    handler.currentBlockIndex = 0;
    handler.blockHasSelectableCharacters = () => true;
    handler.getBlockBoundingRect = (block) => rects.get(block)!;

    const betweenBlocks = handler.constrainVirtualMousePointToBlocks(170, 30);
    expect(betweenBlocks).toMatchObject({ x: 170, y: 30, blockIndex: -1, constrained: false });
    expect(betweenBlocks.block).toBeNull();

    const outsideBlocks = handler.constrainVirtualMousePointToBlocks(-30, 30);
    expect(outsideBlocks).toMatchObject({ x: -30, y: 30, blockIndex: -1, constrained: false });
    expect(outsideBlocks.block).toBeNull();

    const insideSecond = handler.constrainVirtualMousePointToBlocks(250, 30);
    expect(insideSecond).toMatchObject({ x: 250, y: 30, blockIndex: 1, constrained: false });
    expect(insideSecond.block).toBe(blocks[1]);
  });
});

describe("legacy gamepad popup routing", () => {
  it("routes popup action controls only to the topmost visible popup frame", () => {
    const hostMessages: unknown[] = [];
    const parentMessages: unknown[] = [];
    const hiddenChildMessages: unknown[] = [];
    const visibleChildMessages: unknown[] = [];

    legacyGamepadContext.window.postMessage = (message: unknown) => {
      hostMessages.push(message);
    };

    const parentFrame = {
      style: { display: "block", visibility: "visible" },
      getClientRects: () => [1],
      contentWindow: {
        postMessage: (message: unknown) => {
          parentMessages.push(message);
        }
      }
    };
    const hiddenChildFrame = {
      style: { display: "block", visibility: "hidden" },
      getClientRects: () => [],
      contentWindow: {
        postMessage: (message: unknown) => {
          hiddenChildMessages.push(message);
        }
      }
    };
    const visibleChildFrame = {
      style: { display: "block", visibility: "visible" },
      getClientRects: () => [1],
      contentWindow: {
        postMessage: (message: unknown) => {
          visibleChildMessages.push(message);
        }
      }
    };

    legacyGamepadContext.document.querySelectorAll = (selector: string) =>
      selector === "iframe.yomitan-popup"
        ? [parentFrame, hiddenChildFrame, visibleChildFrame]
        : [];
    legacyGamepadContext.document.querySelector = () => null;

    const handler = Object.create(GamepadHandler.prototype) as {
      sendYomitanControlMessage: (action: string, params?: Record<string, unknown>) => void;
    };

    handler.sendYomitanControlMessage("reset-action-selection");

    expect(hostMessages).toEqual([
      {
        type: "gsm-yomitan-control",
        action: "reset-action-selection"
      }
    ]);
    expect(parentMessages).toEqual([]);
    expect(hiddenChildMessages).toEqual([]);
    expect(visibleChildMessages).toEqual([
      {
        type: "gsm-yomitan-control",
        action: "reset-action-selection"
      }
    ]);
  });
});
