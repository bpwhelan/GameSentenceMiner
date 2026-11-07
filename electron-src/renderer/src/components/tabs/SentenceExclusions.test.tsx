// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SentenceExclusions } from "./SentenceExclusions";

describe("sentence exclusions editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();
  let games: Record<string, string[]>;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    games = { "Game A": ["Menu\ntext"], "Game B": ["Different"] };
    invoke.mockReset().mockImplementation(async (channel, payload) => {
      if (channel === "obs.getScenes") return [{ name: "Game A", id: "a" }, { name: "Game B", id: "b" }];
      if (channel === "obs.getActiveScene") return { name: "Game A", id: "a" };
      if (channel === "textprocess.exclusions.add") games = { ...games, [payload.game]: [...(games[payload.game] || []), payload.text] };
      if (channel === "textprocess.exclusions.remove") games = { ...games, [payload.game]: games[payload.game].filter(text => text !== payload.text) };
      return { success: true, games };
    });
    Object.defineProperty(window, "ipcRenderer", { configurable: true, value: { invoke, on: () => () => {} } });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });
  async function render() { await act(async () => root.render(<I18nProvider><SentenceExclusions active /></I18nProvider>)); }

  it("defaults to the active game, switches lists, adds multiline text and removes only the selected entry", async () => {
    await render();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("Game A");
    expect(container.querySelector("li span")?.textContent).toBe("Menu\ntext");
    await act(async () => { select.value = "Game B"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("li span")?.textContent).toBe("Different");
    await act(async () => {
      const input = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "New\nsentence");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(invoke).toHaveBeenCalledWith("textprocess.exclusions.add", { game: "Game B", text: "New\nsentence" });
    await act(async () => container.querySelector<HTMLButtonElement>("li button")!.click());
    expect(games["Game B"]).toEqual(["New\nsentence"]);
    expect(games["Game A"]).toEqual(["Menu\ntext"]);
    expect(invoke.mock.calls.every(([channel]) => channel !== "textprocess.save")).toBe(true);
  });

  it("retains the saved list and shows an error when removal fails", async () => {
    await render();
    invoke.mockResolvedValue({ success: false });
    await act(async () => container.querySelector<HTMLButtonElement>("li button")!.click());
    expect(container.querySelector("li span")?.textContent).toBe("Menu\ntext");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("does not offer a global rule when no game is available", async () => {
    invoke.mockImplementation(async channel => channel === "textprocess.exclusions.list" ? { success: true, games: {} }
      : channel === "obs.getScenes" ? [] : null);
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("No game available");
  });
});
