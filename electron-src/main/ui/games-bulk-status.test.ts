import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const requireModule = createRequire(import.meta.url);
const { JSDOM } = requireModule("jsdom") as {
  JSDOM: new (html: string, options: Record<string, unknown>) => any;
};
const webRoot = path.resolve(process.cwd(), "GameSentenceMiner/web");
const statusLabels = {
  in_progress: "In Progress",
  completed: "Completed",
  planned: "Planned",
  on_hold: "On Hold / Postponed",
  dropped: "Dropped",
};
type UpdateResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

async function loadPage(onUpdate?: (id: string) => Promise<UpdateResponse | undefined>) {
  const dom = new JSDOM(fs.readFileSync(path.join(webRoot, "templates/games.html"), "utf8"), {
    url: "http://localhost/games",
    runScripts: "outside-only",
  });
  const { window } = dom;
  const games = [
    { id: "a", title_original: "Game A", status: "in_progress", completed: false },
    { id: "b", title_original: "Game B", status: "completed", completed: true },
    { id: "c", title_original: "Game C", status: "planned", completed: false },
  ];
  const fetch = vi.fn(async (url: string, options?: { method: string; body: string }) => {
    if (url.startsWith("/api/games-management")) {
      return { ok: true, json: async () => ({ games: structuredClone(games) }) };
    }
    const game = games.find(game => url === `/api/games/${game.id}`);
    if (game && options?.method === "PUT") {
      const response = await onUpdate?.(game.id);
      if (response) return response;
      const { status } = JSON.parse(options.body);
      game.status = status;
      game.completed = status === "completed";
      return { ok: true, json: async () => ({ success: true }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  window.fetch = fetch;
  window.currentGames = [];
  window.escapeHtml = (text: string) => {
    const element = window.document.createElement("div");
    element.textContent = text;
    return element.innerHTML;
  };
  window.showDatabaseSuccessPopup = vi.fn();
  window.showDatabaseErrorPopup = vi.fn();
  window.archiveGames = vi.fn();
  window.eval(fs.readFileSync(path.join(webRoot, "static/js/games.js"), "utf8"));
  await vi.waitFor(() => expect(window.document.querySelectorAll(".game-card")).toHaveLength(3));
  const button = (id: string) => window.document.getElementById(id) as HTMLButtonElement;
  const select = (id: string, value: string) => {
    const element = window.document.getElementById(id) as HTMLSelectElement;
    element.value = value;
    element.dispatchEvent(new window.Event("change"));
  };
  const card = (id: string) => window.document.querySelector(`[data-game-id="${id}"]`);
  const selectGames = () => {
    button("bulkModeToggle").click();
    card("a").click();
    card("b").click();
  };
  const updates = () => fetch.mock.calls.filter(([, options]) => options?.method === "PUT");
  return { dom, window, games, fetch, button, select, card, selectGames, updates };
}

describe("Games page bulk status changes", () => {
  it("requires selected games and an explicit status before enabling Apply", async () => {
    const page = await loadPage();
    try {
      page.button("bulkModeToggle").click();
      for (const id of ["gamesBulkComplete", "gamesBulkStatusSelect", "gamesBulkApplyStatus"]) {
        expect(page.button(id).disabled).toBe(true);
      }
      page.card("a").click();
      expect(page.button("gamesBulkComplete").disabled).toBe(false);
      expect(page.button("gamesBulkStatusSelect").disabled).toBe(false);
      expect(page.button("gamesBulkApplyStatus").disabled).toBe(true);
      page.select("gamesBulkStatusSelect", "on_hold");
      expect(page.button("gamesBulkApplyStatus").disabled).toBe(false);
      page.button("gamesBulkSelectNone").click();
      expect(page.button("gamesBulkApplyStatus").disabled).toBe(true);
      expect(page.updates()).toHaveLength(0);
    } finally { page.dom.window.close(); }
  });

  it("marks only selected games complete and refreshes the list once for the batch", async () => {
    const page = await loadPage();
    try {
      page.selectGames();
      page.button("gamesBulkComplete").click();
      await vi.waitFor(() => expect(page.button("gamesBulkCount").textContent).toBe("0 selected"));
      expect(page.updates().map(([url, options]) => [url, JSON.parse(options!.body)]))
        .toEqual([["/api/games/a", { status: "completed" }], ["/api/games/b", { status: "completed" }]]);
      for (const id of ["a", "b"]) {
        expect(page.card(id).querySelector(".game-card-status-badge").textContent).toBe("Completed");
        expect(page.card(id).querySelector('[data-action="complete"]')).toBeNull();
        expect(page.card(id).querySelector("input").checked).toBe(false);
      }
      expect(page.games[2].status).toBe("planned");
      expect(page.fetch.mock.calls.filter(([url]) => url.startsWith("/api/games-management"))).toHaveLength(2);
      expect(page.button("gamesBulkStatus").textContent).toContain("2 of 2 games");
    } finally { page.dom.window.close(); }
  });

  it.each(Object.entries(statusLabels))("applies %s and keeps completion in sync", async (status, label) => {
    const page = await loadPage();
    try {
      page.selectGames();
      page.select("gamesBulkStatusSelect", status);
      page.button("gamesBulkApplyStatus").click();
      await vi.waitFor(() => expect(page.button("gamesBulkCount").textContent).toBe("0 selected"));
      for (const game of page.games.slice(0, 2)) {
        expect(game.status).toBe(status);
        expect(game.completed).toBe(status === "completed");
        expect(page.card(game.id).querySelector(".game-card-status-badge").textContent).toBe(label);
      }
      expect(page.games[2].status).toBe("planned");
    } finally { page.dom.window.close(); }
  });

  it("applies Select all to filtered games and updates the empty filter state afterward", async () => {
    const page = await loadPage();
    try {
      page.select("gamesStatusFilter", "completed");
      page.button("bulkModeToggle").click();
      page.button("gamesBulkSelectAll").click();
      expect(page.button("gamesBulkCount").textContent).toBe("1 selected");
      page.select("gamesBulkStatusSelect", "on_hold");
      page.button("gamesBulkApplyStatus").click();
      await vi.waitFor(() => expect(page.button("gamesBulkCount").textContent).toBe("0 selected"));
      expect(page.updates().map(([url]) => url)).toEqual(["/api/games/b"]);
      expect(page.button("gamesNoResults").style.display).toBe("flex");
      expect(page.button("gamesGrid").style.display).toBe("none");
    } finally { page.dom.window.close(); }
  });

  it("keeps failed games selected, displays escaped errors, and retries only those games", async () => {
    let failed = true;
    const page = await loadPage(async id => id === "b" && failed ? {
      ok: false, status: 500, json: async () => ({ error: "<strong>Database busy</strong>" }),
    } : undefined);
    try {
      page.selectGames();
      page.button("gamesBulkComplete").click();
      await vi.waitFor(() => expect(page.button("gamesBulkComplete").disabled).toBe(false));
      expect(page.button("gamesBulkCount").textContent).toBe("1 selected");
      expect(page.card("a").querySelector("input").checked).toBe(false);
      expect(page.card("b").querySelector("input").checked).toBe(true);
      expect(page.button("gamesBulkStatus").textContent).toContain("Game B: <strong>Database busy</strong>");
      expect(page.button("gamesBulkStatus").querySelector("strong")).toBeNull();
      failed = false;
      page.button("gamesBulkComplete").click();
      await vi.waitFor(() => expect(page.button("gamesBulkCount").textContent).toBe("0 selected"));
      expect(page.updates().map(([url]) => url)).toEqual(["/api/games/a", "/api/games/b", "/api/games/b"]);
    } finally { page.dom.window.close(); }
  });

  it.each(["network", "non-json"])("continues after a %s failure and unlocks controls", async failure => {
    const page = await loadPage(async id => {
      if (id !== "a") return;
      if (failure === "network") throw new Error("Network unavailable");
      return { ok: false, status: 502, json: async () => { throw new Error("Invalid JSON"); } };
    });
    try {
      page.selectGames();
      page.select("gamesBulkStatusSelect", "dropped");
      page.button("gamesBulkApplyStatus").click();
      await vi.waitFor(() => expect(page.button("gamesBulkApplyStatus").disabled).toBe(false));
      expect(page.games[0].status).toBe("in_progress");
      expect(page.games[1].status).toBe("dropped");
      expect(page.button("gamesBulkCount").textContent).toBe("1 selected");
      expect(page.card("a").querySelector("input").checked).toBe(true);
      expect(page.button("gamesBulkStatus").textContent).toContain("Game A:");
      expect(page.button("gamesBulkStatus").textContent).toContain(failure === "network" ? "Network unavailable" : "502");
      expect(page.button("gamesBulkArchive").disabled).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it("locks selections and competing actions while saving, including after a grid rerender", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const page = await loadPage(async () => { await pending; return undefined; });
    try {
      page.selectGames();
      page.button("gamesBulkComplete").click();
      for (const id of ["gamesBulkComplete", "gamesBulkStatusSelect", "gamesBulkApplyStatus", "gamesBulkMerge",
        "gamesBulkArchive", "gamesBulkDelete", "bulkModeToggle", "gamesBulkSelectAll", "gamesBulkSelectNone"]) {
        expect(page.button(id).disabled).toBe(true);
        page.button(id).click();
      }
      page.select("gamesSortSelect", "title");
      for (const control of page.window.document.querySelectorAll(".game-card-bulk-checkbox, .game-card-menu-btn")) {
        expect((control as HTMLInputElement).disabled).toBe(true);
      }
      page.card("c").click();
      expect(page.button("gamesBulkCount").textContent).toBe("2 selected");
      expect(page.window.archiveGames).not.toHaveBeenCalled();
      finish();
      await vi.waitFor(() => expect(page.button("bulkModeToggle").disabled).toBe(false));
      expect(page.updates()).toHaveLength(2);
      expect(page.button("gamesBulkCount").textContent).toBe("0 selected");
    } finally { finish(); page.dom.window.close(); }
  });
});
