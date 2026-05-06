export const DOCS_HOSTNAME = "docs.gamesentenceminer.com";
const ELECTRON_DOCS_QUERY =
  "?docusaurus-data-navbar=false&docusaurus-data-sidebar=false&docusaurus-data-footer=false";

export const DOCS_URLS = {
  overlay: `https://docs.gamesentenceminer.com/docs/features/overlay${ELECTRON_DOCS_QUERY}`,
  overlayGamepad: `https://docs.gamesentenceminer.com/docs/features/overlay-gamepad${ELECTRON_DOCS_QUERY}`,
  aiFeatures: `https://docs.gamesentenceminer.com/docs/features/ai-features${ELECTRON_DOCS_QUERY}`,
  longplay: `https://docs.gamesentenceminer.com/docs/features/longplay${ELECTRON_DOCS_QUERY}`,
  ankiEnhancement: `https://docs.gamesentenceminer.com/docs/features/anki-enhancement${ELECTRON_DOCS_QUERY}`,
  gamePausing: `https://docs.gamesentenceminer.com/docs/features/game-pausing${ELECTRON_DOCS_QUERY}`,
  ocr: `https://docs.gamesentenceminer.com/docs/features/ocr${ELECTRON_DOCS_QUERY}`,
  autolauncher: `https://docs.gamesentenceminer.com/docs/features/autolauncher${ELECTRON_DOCS_QUERY}`,
} as const;

export type DocsUrl = (typeof DOCS_URLS)[keyof typeof DOCS_URLS];

export function isAllowedDocsUrl(value: unknown): value is DocsUrl {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === DOCS_HOSTNAME;
  } catch (_error) {
    return false;
  }
}
