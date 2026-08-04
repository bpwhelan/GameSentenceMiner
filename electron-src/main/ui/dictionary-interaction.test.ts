import path from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/dictionary_interaction.js",
);

afterEach(() => {
  vi.useRealTimers();
});

function pointerEvent(target: Element, overrides: Record<string, unknown> = {}) {
  return {
    target,
    clientX: 0,
    clientY: 0,
    composedPath: () => [target, target.ownerDocument.body],
    ...overrides,
  };
}

describe("dictionary popup pointer routing", () => {
  it("recognizes Hoshi and shadow-root Yomitan popup clicks", async () => {
    const {
      eventHitsDictionaryPopup,
    } = await import(modulePath);
    const dom = new JSDOM("<!doctype html><body></body>");
    const hoshi = dom.window.document.createElement("section");
    hoshi.id = "hoshidicts-popup-root";
    const host = dom.window.document.createElement("div");
    host.className = "yomitan-popup";
    const shadow = host.attachShadow({ mode: "open" });
    const button = dom.window.document.createElement("button");
    shadow.appendChild(button);
    dom.window.document.body.append(hoshi, host);

    expect(
      eventHitsDictionaryPopup({
        target: hoshi,
        composedPath: () => [hoshi, dom.window.document.body],
      }),
    ).toBe(true);
    expect(
      eventHitsDictionaryPopup({
        target: button,
        composedPath: () => [button, shadow, host, dom.window.document.body],
      }),
    ).toBe(true);
  });

  it("dismisses an open popup only for an outside pointer", async () => {
    const {
      classifyDictionaryPointerEvent,
    } = await import(modulePath);
    const dom = new JSDOM(
      '<!doctype html><body><div id="outside"></div><section id="hoshidicts-popup-root"></section></body>',
    );
    const outside = dom.window.document.querySelector("#outside")!;
    const popup = dom.window.document.querySelector(
      "#hoshidicts-popup-root",
    )!;

    expect(
      classifyDictionaryPointerEvent(pointerEvent(popup), {
        popupActive: true,
      }),
    ).toBe("inside-popup");
    expect(
      classifyDictionaryPointerEvent(pointerEvent(outside), {
        popupActive: true,
      }),
    ).toBe("dismiss-popup");
    expect(
      classifyDictionaryPointerEvent(pointerEvent(outside), {
        popupActive: false,
        interactionSuppressed: true,
      }),
    ).toBe("restore-pass-through");
  });
});

describe("Hoshi pointer lookup intent", () => {
  it("uses the clicked text offset, source line, and rendered Magpie anchor", async () => {
    const {
      buildDictionaryPointerLookupIntent,
    } = await import(modulePath);
    const dom = new JSDOM(
      `<!doctype html><body>
        <p>
          <span class="text-box" data-line-index="2">猫</span>
          <span class="text-box" data-line-index="2">が</span>
          <span
            class="text-box"
            data-line-index="2"
            data-line-id="line-42"
            data-render-generation="9"
            data-source-sentence="猫が走る。"
          >走る。</span>
        </p>
      </body>`,
      { pretendToBeVisual: true },
    );
    const target = dom.window.document.querySelectorAll(".text-box")[2]!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 420,
      left: 900,
      top: 420,
      right: 1020,
      bottom: 460,
      width: 120,
      height: 40,
      toJSON: () => ({}),
    });

    const intent = buildDictionaryPointerLookupIntent(
      pointerEvent(target, {
        clientX: 950,
        clientY: 440,
      }),
      { document: dom.window.document, window: dom.window },
    );

    expect(intent).toMatchObject({
      text: "る。",
      sourceSentence: "猫が走る。",
      lineId: "line-42",
      anchorKey: "9:2:3",
      anchor: {
        x: 900,
        y: 420,
        width: 120,
        height: 40,
      },
    });
  });

  it("does not schedule Hoshi lookup while manual interaction is suppressed", async () => {
    vi.useFakeTimers();
    const {
      DictionaryPointerScanner,
    } = await import(modulePath);
    const dom = new JSDOM(
      '<!doctype html><body><span class="text-box" data-line-index="0">猫</span></body>',
      { pretendToBeVisual: true },
    );
    const target = dom.window.document.querySelector(".text-box")!;
    const lookup = vi.fn(async () => ({ status: "applied" }));
    let suppressed = true;
    const scanner = new DictionaryPointerScanner({
      document: dom.window.document,
      window: dom.window,
      lookup,
      getBackendId: () => "hoshidicts",
      isInteractionSuppressed: () => suppressed,
      debounceMs: 25,
    });

    scanner.handlePointerMove(pointerEvent(target));
    await vi.advanceTimersByTimeAsync(30);
    expect(lookup).not.toHaveBeenCalled();

    suppressed = false;
    scanner.handlePointerMove(pointerEvent(target));
    await vi.advanceTimersByTimeAsync(30);
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ text: "猫" }),
    );
    scanner.dispose();
  });
});

describe("dictionary interaction diagnostics", () => {
  it("reports popup, focus, click-through, manual, and Magpie ownership", async () => {
    const {
      buildDictionaryInteractionSnapshot,
    } = await import(modulePath);

    expect(
      buildDictionaryInteractionSnapshot({
        popup: {
          active: true,
          backendId: "hoshidicts",
          popupCount: 2,
          generation: 14,
        },
        focusOnLookup: true,
        manualMode: true,
        manualHoldActive: false,
        manualToggleActive: false,
        gamepadNavigationActive: false,
        resizeMode: false,
        magpieState: { active: true, signature: "scaled" },
      }),
    ).toEqual({
      popup: {
        active: true,
        owner: "hoshidicts",
        count: 2,
        generation: 14,
      },
      focusOwner: "dictionary-popup",
      expectedClickThrough: false,
      manual: {
        enabled: true,
        holdActive: false,
        toggleActive: false,
        interactionSuppressed: true,
      },
      magpie: {
        active: true,
        signature: "scaled",
      },
    });
  });
});
