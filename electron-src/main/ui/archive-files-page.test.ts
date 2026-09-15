import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const requireModule = createRequire(import.meta.url);
const { JSDOM } = requireModule("jsdom") as {
  JSDOM: new (html: string, options: Record<string, unknown>) => any;
};
const webRoot = path.resolve(process.cwd(), "GameSentenceMiner/web");

async function loadPage({ confirm = true, failed = false, damaged = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(webRoot, "templates/database.html"), "utf8"), {
    url: "http://localhost/tools", runScripts: "outside-only"
  });
  const { window } = dom;
  let deleted = false;
  let action = "";
  const fetch = vi.fn(async (url: string, options?: { body: string }) => {
    let data: unknown;
    if (url === "/api/database/maintenance") {
      data = { settings: { vacuum_interval_days: 0, archive_after_days: 0 },
        storage: { database_bytes: 1048576, reclaimable_bytes: 0, raw_lines: 0, archived_lines: 2 } };
    } else if (url === "/api/database/archive-files") {
      data = { directory: "C:\\GSM\\archives\\games", archives: deleted ? [] : [{
        file_id: "a".repeat(64), filename: "game.gsm-archive.zip", game_name: "日本語 <game>",
        line_count: 2, size_bytes: 12345, can_restore: !damaged, error: damaged ? "Damaged archive" : undefined
      }] };
    } else if (url.endsWith("/restore") || url.endsWith("/delete")) {
      expect(JSON.parse(options!.body)).toEqual({ confirm: true });
      action = url.endsWith("/restore") ? "restore" : "delete";
      data = { id: "file-job" };
    } else if (url === "/api/database/maintenance/jobs/file-job") {
      if (failed) data = { status: "failed", error: "Unable to restore this archive" };
      else {
        deleted = action === "delete";
        data = { status: "completed", result: action === "restore" ? { restored_lines: 2, skipped_lines: 0 } : {} };
      }
    } else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => data };
  });
  window.fetch = fetch;
  window.confirm = vi.fn(() => confirm);
  const setTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback: () => void) => setTimeout(callback, 0);
  window.eval(fs.readFileSync(path.join(webRoot, "static/js/database-game-operations.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(webRoot, "static/js/database-maintenance.js"), "utf8"));
  await vi.waitFor(() => expect(window.document.querySelectorAll(".archive-file-row")).toHaveLength(1));
  const button = (action: string) => window.document.querySelector(`[data-archive-action="${action}"]`) as HTMLButtonElement;
  const status = () => window.document.getElementById("archiveFilesStatus").textContent;
  return { dom, window, fetch, button, status };
}

describe("Saved game archive files", () => {
  it("shows safely escaped game names and a ZIP download", async () => {
    const page = await loadPage();
    try {
      expect(page.window.document.querySelector(".archive-file-name").textContent).toBe("日本語 <game>");
      expect(page.window.document.querySelector(".archive-file-name game")).toBeNull();
      expect(page.window.document.querySelector(".archive-file-row a").getAttribute("href"))
        .toBe(`/api/database/archive-files/${"a".repeat(64)}/download`);
      expect(page.window.document.getElementById("archiveFilesDirectory").textContent).toBe("C:\\GSM\\archives\\games");
    } finally { page.dom.window.close(); }
  });

  it("restores sentences and keeps the ZIP listed", async () => {
    const page = await loadPage();
    try {
      page.button("restore").click();
      expect(page.button("delete").disabled).toBe(true);
      await vi.waitFor(() => expect(page.status()).toContain("Restored 2 sentences"));
      expect(page.window.document.querySelectorAll(".archive-file-row")).toHaveLength(1);
      expect(page.window.confirm).toHaveBeenCalledOnce();
    } finally { page.dom.window.close(); }
  });

  it("deletes only after confirmation and explains that statistics remain", async () => {
    const page = await loadPage();
    try {
      page.button("delete").click();
      await vi.waitFor(() => expect(page.status()).toContain("Statistics and kanji are unchanged"));
      expect(page.window.confirm.mock.calls[0][0]).toContain("Statistics and kanji will remain");
      expect(page.window.document.querySelectorAll(".archive-file-row")).toHaveLength(0);
    } finally { page.dom.window.close(); }
  });

  it("cancels deletion without sending a mutation", async () => {
    const page = await loadPage({ confirm: false });
    try {
      page.button("delete").click();
      expect(page.fetch.mock.calls.some(([url]) => url.endsWith("/delete"))).toBe(false);
      expect(page.button("delete").disabled).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it("keeps controls usable after a restore failure", async () => {
    const page = await loadPage({ failed: true });
    try {
      page.button("restore").click();
      await vi.waitFor(() => expect(page.status()).toBe("Unable to restore this archive"));
      expect(page.button("restore").disabled).toBe(false);
      expect(page.button("delete").disabled).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it("allows damaged files to be downloaded or deleted without offering restore", async () => {
    const page = await loadPage({ damaged: true });
    try {
      expect(page.button("restore").disabled).toBe(true);
      expect(page.button("delete").disabled).toBe(false);
      expect(page.window.document.querySelector(".archive-file-row").textContent).toContain("Damaged archive");
    } finally { page.dom.window.close(); }
  });
});
