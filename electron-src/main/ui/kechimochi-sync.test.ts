import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const root = path.resolve(process.cwd(), "GameSentenceMiner/web");

async function page() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "templates/components/kechimochi-sync-card.html"), "utf8"), {
    url: "http://localhost/tools", runScripts: "outside-only"
  });
  const { window } = dom;
  const settings = {
    url: "http://127.0.0.1:3031", enabled: false, schedule: "quarter_hourly", sync_time: "00:05",
    include_external_stats: true, sync_covers: true, adopt_matching_logs: false
  };
  let syncState = "idle";
  let failSave = false;
  const fetch = vi.fn(async (url: string, options?: { body: string }) => {
    const data = options?.body ? JSON.parse(options.body) : undefined;
    if (url.endsWith("/status")) return { ok: true, json: async () => ({ status: syncState, settings, next_run: null }) };
    if (url.endsWith("/settings")) {
      if (failSave) return { ok: false, json: async () => ({ error: "Wait for the current sync" }) };
      Object.assign(settings, data);
      if (settings.enabled) syncState = "running";
      return { ok: true, json: async () => settings };
    }
    if (url.endsWith("/preview")) return { ok: true, json: async () => ({
      media_count: 1, activity_count: 1, characters: 3, duration_minutes: 1, first_date: "2010-01-01", last_date: "2010-01-01",
      entries: [{ date: "2010-01-01", title: '<img src=x onerror="alert(1)">', characters: 3, duration_minutes: 1 }]
    }) };
    if (url.endsWith("/sync")) { syncState = "running"; return { ok: true, json: async () => ({ status: "queued" }) }; }
    if (url.endsWith("/test")) return { ok: true, json: async () => ({ version: "http-0.3.2", media_count: 1 }) };
    throw new Error(`Unexpected API call: ${url}`);
  });
  window.fetch = fetch;
  window.eval(fs.readFileSync(path.join(root, "static/js/kechimochi-sync.js"), "utf8"));
  const el = (name: string): any => window.document.getElementById(`kechimochi${name}`);
  await vi.waitFor(() => expect(el("Sync").disabled).toBe(false));
  const change = (name: string, value: string) => {
    el(name).value = value;
    el(name).dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const save = () => el("SettingsForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  return { dom, window, settings, fetch, el, change, save, failSave: () => { failSave = true; } };
}

describe("Kechimochi sync controls", () => {
  it("saves scheduling and starts automatic sync while preventing overlapping actions", async () => {
    const p = await page();
    try {
      p.change("Schedule", "daily");
      expect(p.el("TimeGroup").hidden).toBe(false);
      p.change("Time", "06:30");
      p.el("Enabled").checked = true;
      expect(p.el("Sync").disabled).toBe(true);
      p.save();
      await vi.waitFor(() => expect(p.el("Sync").textContent).toBe("Syncing…"));
      expect(p.settings).toMatchObject({ enabled: true, schedule: "daily", sync_time: "06:30" });
      expect(p.el("Fields").disabled).toBe(true);
      expect(p.fetch.mock.calls.filter(([url]) => url.endsWith("/settings"))).toHaveLength(1);
    } finally { p.dom.window.close(); }
  });

  it("keeps unsaved values after a failed save and exposes the error", async () => {
    const p = await page();
    try {
      p.failSave();
      p.change("Url", "http://localhost:4040");
      p.save();
      await vi.waitFor(() => expect(p.el("Message").textContent).toBe("Wait for the current sync"));
      expect(p.el("Url").value).toBe("http://localhost:4040");
      expect(p.el("Sync").disabled).toBe(true);
    } finally { p.dom.window.close(); }
  });

  it("renders history titles as text and uses the complete history summary", async () => {
    const p = await page();
    try {
      p.el("Preview").click();
      await vi.waitFor(() => expect(p.el("PreviewPanel").hidden).toBe(false));
      expect(p.el("PreviewRows").textContent).toContain('<img src=x onerror="alert(1)">');
      expect(p.el("PreviewRows").querySelector("img")).toBeNull();
      expect(p.el("PreviewSummary").textContent).toContain("2010-01-01");
    } finally { p.dom.window.close(); }
  });
});
