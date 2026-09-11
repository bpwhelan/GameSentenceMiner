import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

function setup() {
  const dom = new JSDOM('<body></body>');
  const module = { exports: {} as any };
  vm.runInNewContext(fs.readFileSync(path.resolve("GSM_Overlay/block_translation.js"), "utf8"), { module, window: dom.window });
  const sent: any[] = [];
  const errors: string[] = [];
  let revision = 0;
  const controller = module.exports.createBlockTranslationController({
    document: dom.window.document,
    send: (payload: any) => sent.push(payload),
    showLegacy: () => {},
    showError: (error: string) => errors.push(error),
    getRevision: () => revision,
  });
  function add(text: string, left: number, top: number) {
    const container = dom.window.document.createElement("p");
    container.className = "text-block-container";
    container.dataset.translationSource = text;
    const box = dom.window.document.createElement("span");
    box.className = "text-box";
    box.getBoundingClientRect = () => ({ left, top, right: left + 150, bottom: top + 50, width: 150, height: 50 } as DOMRect);
    container.append(box);
    dom.window.document.body.append(container);
    return container;
  }
  add("こんにちは", 20, 30);
  add("終了", 700, 500);
  return { dom, controller, sent, errors, add, invalidate: () => revision++ };
}

describe("overlay block translation", () => {
  it("batches blocks once and positions reordered results over their own bounds", () => {
    const { dom, controller, sent } = setup();
    controller.request();
    controller.request();
    expect(sent).toHaveLength(1);
    expect(sent[0].blocks.map((b: any) => b.text)).toEqual(["こんにちは", "終了"]);
    controller.receive({ request_id: sent[0].request_id, blocks: [
      { id: "1", translation: "Quit" }, { id: "0", translation: "Hello <script>" },
    ] });
    const panels = [...dom.window.document.querySelectorAll<HTMLElement>(".block-translation")];
    expect(panels.map(p => [p.textContent, p.style.left, p.style.top])).toEqual([
      ["Hello <script>", "20px", "30px"], ["Quit", "700px", "500px"],
    ]);
    expect(dom.window.document.querySelector("script")).toBeNull();
  });

  it("discards replies after text nodes were replaced, even with identical text", () => {
    const { dom, controller, sent, add } = setup();
    controller.request();
    dom.window.document.querySelectorAll(".text-block-container").forEach(n => n.remove());
    add("こんにちは", 40, 60);
    controller.receive({ request_id: sent[0].request_id, blocks: [{ id: "0", translation: "Hello" }] });
    expect(dom.window.document.getElementById("translation-display")).toBeNull();
  });

  it("ignores old errors and permits retrying a failed current request", () => {
    const { controller, sent, errors } = setup();
    controller.request();
    controller.error({ request_id: "old", error: "stale" });
    expect(errors).toEqual([]);
    controller.error({ request_id: sent[0].request_id, error: "Invalid JSON" });
    controller.request();
    expect(sent).toHaveLength(2);
    expect(errors).toEqual(["Invalid JSON"]);
  });

  it("discards replies when OCR presence is invalidated without removing nodes", () => {
    const { dom, controller, sent, invalidate } = setup();
    controller.request();
    invalidate();
    controller.receive({ request_id: sent[0].request_id, blocks: [
      { id: "0", translation: "Hello" }, { id: "1", translation: "Quit" },
    ] });
    expect(dom.window.document.getElementById("translation-display")).toBeNull();
  });
});
