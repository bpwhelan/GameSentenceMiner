// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipLayer } from "./Tooltip";

describe("shared tooltips", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<>
        <TooltipLayer />
        <div data-tip="Outer help">
          <button data-tip="Button help"><span>Action</span></button>
          <input id="disabled" type="checkbox" disabled data-tip="Why this is disabled" />
        </div>
        <label htmlFor="field" data-tip="Field help">Field</label>
        <input id="field" aria-describedby="existing-description" />
        <p id="existing-description">Existing description</p>
        <iframe title="Document" />
      </>);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function hover(element: Element) {
    await act(async () => element.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  }

  it("shows one custom tooltip for the closest target outside scrolling containers", async () => {
    await hover(container.querySelector("button span")!);
    const tips = document.querySelectorAll('[role="tooltip"]');
    expect(tips).toHaveLength(1);
    expect(tips[0].textContent).toBe("Button help");
    expect(tips[0].parentElement).toBe(document.body);
  });

  it("shows explanations when hovering disabled controls", async () => {
    await hover(container.querySelector("#disabled")!);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Why this is disabled");
  });

  it("supports keyboard focus through associated labels and restores existing descriptions on Escape", async () => {
    const field = container.querySelector<HTMLInputElement>("#field")!;
    await act(async () => field.focus());
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toBe("Field help");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toEqual(["existing-description", tooltip.id]);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(field.getAttribute("aria-describedby")).toBe("existing-description");
  });

  it("updates translated or changing tooltip text and closes when the target is removed", async () => {
    const button = container.querySelector("button")!;
    await hover(button);
    await act(async () => button.setAttribute("data-tip", "Updated help"));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Updated help");
    await act(async () => button.remove());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("dismisses tooltips on pointer exit and scrolling without changing semantic iframe titles", async () => {
    const button = container.querySelector("button")!;
    await hover(button);
    await act(async () => button.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await hover(button);
    await act(async () => container.dispatchEvent(new Event("scroll")));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector("iframe")?.title).toBe("Document");
  });

  it("keeps the tooltip inside the viewport near the bottom-right edge", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip"
        ? { width: 300, height: 120, left: 0, top: 0, right: 300, bottom: 120 } as DOMRect
        : { width: 40, height: 30, left: window.innerWidth - 40, top: window.innerHeight - 30,
            right: window.innerWidth, bottom: window.innerHeight } as DOMRect;
    });
    await hover(container.querySelector("button")!);
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(parseFloat(tooltip.style.left) + 300).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(parseFloat(tooltip.style.top) + 120).toBeLessThanOrEqual(window.innerHeight - 8);
  });
});
