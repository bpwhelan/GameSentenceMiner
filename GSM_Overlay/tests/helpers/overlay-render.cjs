const fs = require('node:fs');
const path = require('node:path');
const { between } = require('./overlay-startup.cjs');

const overlayRoot = path.resolve(__dirname, '../..');

// Run the production coordinate-rendering branch in Chromium, with enrichment
// and application I/O disabled. Keep the real CSS and DOM geometry APIs.
function rendererFixtureSource(html, blockSource) {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  // Preserve the older branch for the historical renderer comparison, while
  // exercising the current production preparation and detection together.
  const detectionSource = html.includes('          const blockLayoutOptions = {')
    ? between(html, '          const blockLayoutOptions = {', '          const renderSignatureInfo = getOverlayTextRenderSignature(')
    : `const { lineBlocks, blockBoundaries, blockMetadata, blockCount: currentBlockId } = detectTextBlocks(
        data.data, undefined, isSupplemental ? null : recentBlockHistory,
        { resultKey: data.line_id == null ? null : String(data.line_id), latestText: data.latest_text || null }
      );`;
  return `(() => {
    document.head.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(styles)};
    document.head.appendChild(style);
    ${blockSource}
    const { detectTextBlocks, getMedianValue, insertBlockSeparatorAfter, createRecentBlockHistory, prepareTextLines } = window.GSMBlockDetection;
    let recentBlockHistory = createRecentBlockHistory();
    ${between(html, '  const CJK_LEXICAL_REGEX =', '  function requestMagpieMouseRelease(')}
    const magpieController = null, display = null;
    const mainBox = document.createElement('div');
    let offsetX = 0, offsetY = 0, lastOverlayTextRenderSignature = null;
    let isMagpieActive = false, currentMagpieInfo = null;
    let showTextIndicators = true, fadeTextIndicators = false;
    const console = { log() {} };
    const prepareGamepadForOverlayTextRender = () => null;
    const clearTextBoxes = () => document.querySelectorAll('.text-box, .text-block-container, .line-box, .big-interactive-area, .block-separator, .recycled-indicator').forEach(node => node.remove());
    ${between(html, '  function mapPercentToMagpie(', '  // Track multiple Yomitan popups')}
    ${between(html, '  function isOverlayLineVertical(', '  function prepareGamepadForOverlayTextRender(')}
    ${between(html, '  function applyTextBoxLayout(', '  function getFuriganaAnnotationsForLine(')}
    ${between(html, '  function isTextInMainBox(', '  function setMouseEventHandlers(')}
    ${between(html, '  function applyIndicatorBoxStyles(', '  function updateTextIndicators(')}
    window.renderFixture = (data, options = {}) => {
      offsetX = options.offsetX || 0;
      offsetY = options.offsetY || 0;
      isMagpieActive = !!options.magpie;
      currentMagpieInfo = options.magpie || null;
      const pinned = !!options.pinned;
      const mainBoxBounds = options.mainBoxBounds || { left: 0, top: 0, right: 0, bottom: 0 };
      const isSupplemental = !!options.supplemental;
      const stalePresenceAction = null;
      const showRecycledIndicator = true;
      const isSentenceRecycled = !!options.recycled;
      let statsBounds = null;
      window.GSMLiveStatsWidget = { handleTextBoundsUpdate(bounds) {
        statsBounds = bounds.map(rect => rect.toJSON());
      } };
      ${detectionSource}
      ${between(html, '          const renderSignatureInfo = getOverlayTextRenderSignature(', '          // Skip furigana rendering for supplemental results')}
      lastOverlayTextRenderSignature = isSupplemental ? null : renderSignatureInfo.signature;
      // Include the final layout flush, but exclude snapshot serialization from
      // timings. Snapshots are only needed for the equality checks above.
      if (options.measureOnly) return document.body.getBoundingClientRect().height;
      return {
        html: document.body.innerHTML,
        bounds: [...document.querySelectorAll('.text-box')].map(node => node.getBoundingClientRect().toJSON()),
        statsBounds,
        recalibration: isRecalibration,
      };
    };
    window.resetFixture = () => { document.body.innerHTML = ''; lastOverlayTextRenderSignature = null; recentBlockHistory = createRecentBlockHistory(); };
  })()`;
}

function line(text, x, y, width, height, vertical = false, perCharacter = false) {
  const glyphs = perCharacter ? Array.from(text) : [text];
  const words = glyphs.map((text, index) => ({
    text,
    bounding_rect: {
      x1: x + (vertical ? 0 : width * index / glyphs.length),
      y1: y + (vertical ? height * index / glyphs.length : 0),
      x3: x + (vertical ? width : width * (index + 1) / glyphs.length),
      y3: y + (vertical ? height * (index + 1) / glyphs.length : height),
    },
  }));
  return { text, words, bounding_rect: { x1: x, y1: y, x3: x + width, y3: y + height } };
}

function renderCases() {
  const cases = [];
  for (const text of ['「日本語の台詞です……!?」', '漢字ABC123 ｶﾅ𠮷🙂。', 'English words, punctuation!', 'Привіт світе!', '']) {
    for (const vertical of [false, true]) {
      for (const perCharacter of [false, true]) {
        cases.push({ data: [line(text, 0.125, 0.237, vertical ? 0.025 : 0.63, vertical ? 0.5 : 0.047, vertical, perCharacter)] });
      }
    }
  }
  cases.push({ data: [line('名前', 0.1, 0.5, 0.1, 0.05), line('「台詞その一。」', 0.1, 0.6, 0.6, 0.07), line('「続き……」', 0.1, 0.7, 0.6, 0.06), line('画面の端', 0.8, 0.05, 0.1, 0.05)] });
  cases.push({ data: Array.from({ length: 16 }, (_, i) => line('漢字かなABC123。'.repeat(4), 0.05, 0.03 + i * 0.059, 0.86, 0.027, false, true)) });
  return cases;
}

module.exports = { rendererFixtureSource, renderCases, line, overlayRoot, readRenderer: () => fs.readFileSync(path.join(overlayRoot, 'index.html'), 'utf8') };
