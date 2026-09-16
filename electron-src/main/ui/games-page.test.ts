import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const requireModule = createRequire(import.meta.url);
const { JSDOM } = requireModule("jsdom") as {
  JSDOM: new (html: string, options: Record<string, unknown>) => any;
};
const webRoot = path.resolve(process.cwd(), "GameSentenceMiner/web");

async function loadGamesPage(confirm = true, failed = false) {
  const dom = new JSDOM(fs.readFileSync(path.join(webRoot, "templates/games.html"), "utf8"), {
    url: "http://localhost/games", runScripts: "outside-only"
  });
  const { window } = dom;
  const games = [
    { id: "a", title_original: "日本語", has_image: true, line_count: 2 },
    { id: "b", title_original: "学習", image: "data:image/png;base64,AAAA", line_count: 2 },
    { id: "c", title_original: "No cover", line_count: 1 }
  ];
  const result = {
    archived_games: failed ? 1 : 2, archived_lines: failed ? 2 : 4, skipped_games: 0,
    successful_game_ids: failed ? ["a"] : ["a", "b"],
    failed_games: failed ? [{ game_id: "b", game_name: "学習", error: "Tokenization unavailable" }] : []
  };
  const fetch = vi.fn(async (url: string, options?: { body: string }) => {
    if (url.startsWith("/api/games-management")) return { ok: true, json: async () => ({ games }) };
    if (url === "/api/games/archive/preview") {
      return { ok: true, json: async () => ({ game_count: 2, raw_lines: 4 }) };
    }
    if (url === "/api/games/archive") {
      expect(JSON.parse(options!.body)).toEqual({ game_ids: ["a", "b"], confirm: true });
      return { ok: true, json: async () => ({ id: "batch-job" }) };
    }
    if (url === "/api/database/maintenance/jobs/batch-job") {
      return { ok: true, json: async () => ({ status: "completed", result }) };
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
  window.confirm = vi.fn(() => confirm);
  window.showDatabaseSuccessPopup = vi.fn();
  window.showDatabaseErrorPopup = vi.fn();
  const setTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback: () => void) => setTimeout(callback, 0);
  window.eval(fs.readFileSync(path.join(webRoot, "static/js/database-game-operations.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(webRoot, "static/js/games.js"), "utf8"));
  await vi.waitFor(() => expect(window.document.querySelectorAll(".game-card")).toHaveLength(3));
  const button = (id: string) => window.document.getElementById(id) as HTMLButtonElement;
  const selectGames = () => {
    button("bulkModeToggle").click();
    expect(button("gamesBulkArchive").disabled).toBe(true);
    window.document.querySelector('[data-game-id="a"]').click();
    window.document.querySelector('[data-game-id="b"]').click();
    expect(button("gamesBulkArchive").disabled).toBe(false);
  };
  return { dom, window, fetch, button, selectGames };
}

describe("Games page archiving and covers", () => {
  it("keeps the visible titles while removing cover alt text that Yomitan scans", async () => {
    const page = await loadGamesPage();
    try {
      const images = [...page.window.document.querySelectorAll(".game-card-image-container img")];
      expect(images).toHaveLength(3);
      for (const image of images) expect((image as HTMLImageElement).alt).toBe("");
      expect(page.window.document.querySelector('[data-game-id="a"] .game-card-title').textContent).toBe("日本語");
    } finally { page.dom.window.close(); }
  });

  it("archives selected games with one confirmation and clears successful selections", async () => {
    const page = await loadGamesPage();
    try {
      page.selectGames();
      page.button("gamesBulkArchive").click();
      expect(page.button("gamesBulkMerge").disabled).toBe(true);
      expect(page.button("gamesBulkDelete").disabled).toBe(true);
      await vi.waitFor(() => expect(page.button("gamesBulkCount").textContent).toBe("0 selected"));
      expect(page.window.confirm).toHaveBeenCalledOnce();
      expect(page.window.confirm.mock.calls[0][0]).toContain("4 original sentences");
      expect(page.fetch.mock.calls.filter(([url]) => url === "/api/games/archive")).toHaveLength(1);
      expect(page.window.document.getElementById("gamesBulkStatus").textContent).toContain("Archived 4 sentences");
    } finally { page.dom.window.close(); }
  });

  it("cancels without archiving or clearing the selection", async () => {
    const page = await loadGamesPage(false);
    try {
      page.selectGames();
      page.button("gamesBulkArchive").click();
      await vi.waitFor(() => expect(page.button("gamesBulkArchive").disabled).toBe(false));
      expect(page.button("gamesBulkCount").textContent).toBe("2 selected");
      expect(page.fetch.mock.calls.some(([url]) => url === "/api/games/archive")).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it("keeps failed games selected and shows their errors", async () => {
    const page = await loadGamesPage(true, true);
    try {
      page.selectGames();
      page.button("gamesBulkArchive").click();
      await vi.waitFor(() => expect(page.button("gamesBulkCount").textContent).toBe("1 selected"));
      expect(page.window.document.querySelector('[data-game-id="b"] input').checked).toBe(true);
      expect(page.window.document.querySelector('[data-game-id="a"] input').checked).toBe(false);
      expect(page.window.document.getElementById("gamesBulkStatus").textContent).toContain("Tokenization unavailable");
    } finally { page.dom.window.close(); }
  });
});
