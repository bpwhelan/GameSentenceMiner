import path from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/hoshidicts_glossary_renderer.js",
);
const dictionaryId = "11111111-1111-4111-8111-111111111111";

describe("HoshiDicts glossary rendering", () => {
  it("renders plain glossary strings only as text", async () => {
    const { renderGlossaryContent } = await import(modulePath);
    const dom = new JSDOM("<body></body>");
    const rendered = renderGlossaryContent({
      document: dom.window.document,
      content: '<img src=x onerror="globalThis.pwned=true"><script>bad()</script>',
      dictionaryId,
    });

    expect(rendered.element.textContent).toContain("<img src=x");
    expect(rendered.element.querySelector("img")).toBeNull();
    expect(rendered.element.querySelector("script")).toBeNull();
    expect(rendered.mediaPromises).toEqual([]);
  });

  it("uses an explicit structured-content allowlist", async () => {
    const { renderGlossaryContent } = await import(modulePath);
    const dom = new JSDOM("<body></body>");
    const content = JSON.stringify({
      type: "structured-content",
      content: [
        {
          tag: "span",
          data: { code: "safe", onclick: "bad()" },
          style: {
            fontWeight: "700",
            color: "#cc0000",
            position: "fixed",
            backgroundImage: "url(javascript:bad())",
          },
          content: "safe text",
        },
        {
          tag: "script",
          content: "globalThis.pwned=true",
        },
        {
          tag: "a",
          href: "javascript:bad()",
          content: "unsafe link",
        },
      ],
    });
    const rendered = renderGlossaryContent({
      document: dom.window.document,
      content,
      dictionaryId,
    });

    const span = rendered.element.querySelector("span");
    expect(span?.textContent).toBe("safe text");
    expect(span?.getAttribute("data-code")).toBe("safe");
    expect(span?.getAttribute("data-onclick")).toBeNull();
    expect(span?.style.fontWeight).toBe("700");
    expect(span?.style.color).not.toBe("");
    expect(span?.style.position).toBe("");
    expect(span?.style.backgroundImage).toBe("");
    expect(rendered.element.querySelector("script")).toBeNull();
    expect(rendered.element.querySelector("a")).toBeNull();
    expect(rendered.element.textContent).not.toContain("globalThis.pwned");
  });

  it("resolves image nodes through the owning dictionary media callback", async () => {
    const { renderGlossaryContent } = await import(modulePath);
    const dom = new JSDOM("<body></body>");
    const resolveMedia = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
    }));
    const content = JSON.stringify({
      type: "structured-content",
      content: {
        tag: "img",
        path: "media/picture.png",
        title: "Dictionary diagram",
        width: 640,
        height: 480,
      },
    });
    const rendered = renderGlossaryContent({
      document: dom.window.document,
      content,
      dictionaryId,
      resolveMedia,
    });

    expect(resolveMedia).toHaveBeenCalledWith(
      dictionaryId,
      "media/picture.png",
    );
    await Promise.all(rendered.mediaPromises);
    const image = rendered.element.querySelector("img");
    expect(image?.src).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(image?.alt).toBe("Dictionary diagram");
    expect(image?.getAttribute("width")).toBe("640");
    expect(image?.getAttribute("height")).toBe("480");
  });

  it("bounds recursive structured nodes", async () => {
    const { renderGlossaryContent } = await import(modulePath);
    const dom = new JSDOM("<body></body>");
    let nested: any = "end";
    for (let index = 0; index < 40; index += 1) {
      nested = { tag: "span", content: nested };
    }

    const rendered = renderGlossaryContent({
      document: dom.window.document,
      content: JSON.stringify({
        type: "structured-content",
        content: nested,
      }),
      dictionaryId,
    });

    expect(rendered.truncated).toBe(true);
    expect(rendered.element.querySelectorAll("span").length).toBeLessThanOrEqual(
      16,
    );
  });
});

describe("HoshiDicts dictionary CSS", () => {
  it("scopes safe rules beneath the dictionary popup and dictionary owner", async () => {
    const { sanitizeDictionaryCss } = await import(modulePath);
    const result = sanitizeDictionaryCss(
      `
        .definition, span[data-code="safe"] {
          color: #b91c1c;
          font-weight: 600;
          margin-top: 0.25em;
        }
      `,
      dictionaryId,
    );

    expect(result.css).toContain(
      `#hoshidicts-popup-root [data-hoshi-dictionary-id="${dictionaryId}"] .definition`,
    );
    expect(result.css).toContain("font-weight: 600");
    expect(result.rejectedRules).toBe(0);
  });

  it.each([
    ["global selector", "body { color: red; }"],
    ["root selector", ":root { color: red; }"],
    ["import", '@import url("https://example.invalid/x.css");'],
    ["scriptable URL", ".x { background: url(javascript:alert(1)); }"],
    ["escape", ".x\\62 ody { color: red; }"],
    ["layout escape", ".x { position: fixed; inset: 0; z-index: 999999; }"],
  ])("rejects %s", async (_label, css) => {
    const { sanitizeDictionaryCss } = await import(modulePath);
    const result = sanitizeDictionaryCss(css, dictionaryId);

    expect(result.css).toBe("");
    expect(result.rejectedRules).toBeGreaterThan(0);
  });
});
