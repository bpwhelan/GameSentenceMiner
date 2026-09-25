(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GSMBlockTranslation = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  function createBlockTranslationController({ document, send, showLegacy, showError, showAnalysis = showLegacy, onStart = () => {}, getRevision = () => 0 }) {
    let sequence = 0;
    let active = null;

    function capture() {
      return Array.from(document.querySelectorAll('.text-block-container')).map(node => {
        const boxes = Array.from(node.querySelectorAll('.text-box')).filter(box => {
          const rect = box.getBoundingClientRect();
          return box.style.display !== 'none' && rect.width > 0 && rect.height > 0;
        });
        return { node, boxes, text: node.dataset.translationSource || '' };
      }).filter(block => block.boxes.length && block.text.trim());
    }

    function matches(blocks) {
      return active && active.revision === getRevision() && blocks.length === active.blocks.length && blocks.every((block, index) => {
        const previous = active.blocks[index];
        return block.node === previous.node && block.text === previous.text
          && block.boxes.length === previous.boxes.length
          && block.boxes.every((box, i) => box === previous.boxes[i]);
      });
    }

    function request({ mode = 'translation', automatic = false } = {}) {
      const blocks = capture();
      if (matches(blocks) && active.mode === mode && (active.pending || (mode === 'translation' && document.getElementById('translation-display')))) return;
      if (mode !== 'translation' && !blocks.length) {
        showError('No text blocks available. Scan some game text first.', mode);
        return;
      }
      const request_id = `overlay-translation-${++sequence}`;
      active = { request_id, blocks, mode, pending: true, revision: getRevision() };
      onStart(mode);
      send({ type: 'translate-request', request_id, mode, automatic,
        ...(blocks.length ? { blocks: blocks.map((block, i) => ({ id: String(i), text: block.text })) } : {}) });
    }

    function receive(payload) {
      if (typeof payload === 'string') {
        showLegacy(payload);
        return;
      }
      if (!active || payload?.request_id !== active.request_id) return;
      if (!matches(capture())) {
        const mode = active.mode;
        active = null;
        if (mode !== 'translation') showError('The source text changed. Select Explain again for the current text.', mode);
        return;
      }
      active.pending = false;
      if (typeof payload.text === 'string') {
        if (active.mode !== 'translation') showAnalysis(payload.text, active.mode);
        else showLegacy(payload.text);
        return;
      }
      if (!Array.isArray(payload.blocks)) return;
      const translations = new Map(payload.blocks.map(block => [block.id, block.translation]));
      if (translations.size !== active.blocks.length || payload.blocks.length !== active.blocks.length
        || active.blocks.some((_, i) => typeof translations.get(String(i)) !== 'string' || !translations.get(String(i)).trim())) {
        error({ request_id: active.request_id, error: 'Incomplete block translation response' });
        return;
      }
      document.getElementById('translation-display')?.remove();
      const layer = document.createElement('div');
      layer.id = 'translation-display';
      Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '10001' });
      document.body.appendChild(layer);
      active.blocks.forEach((block, index) => {
        // Measure actual rendered boxes, including Magpie scaling and recalibration.
        const rects = block.boxes.map(box => box.getBoundingClientRect());
        const left = Math.min(...rects.map(rect => rect.left));
        const top = Math.min(...rects.map(rect => rect.top));
        const width = Math.max(...rects.map(rect => rect.right)) - left;
        const height = Math.max(...rects.map(rect => rect.bottom)) - top;
        const panel = document.createElement('div');
        panel.className = 'block-translation';
        panel.dataset.blockId = String(index);
        Object.assign(panel.style, {
          position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
          boxSizing: 'border-box', padding: '2px 4px', overflow: 'hidden',
          backgroundColor: 'rgba(0, 0, 0, 0.97)', color: 'white', borderRadius: '4px',
          border: '1px solid rgba(0, 255, 136, 0.5)', textAlign: 'center',
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: '1.15', userSelect: 'none',
        });
        panel.textContent = translations.get(String(index));
        layer.appendChild(panel);
        let fontSize = Math.min(32, Math.max(10, parseFloat(document.defaultView.getComputedStyle(block.boxes[0]).fontSize) || 24));
        panel.style.fontSize = `${fontSize}px`;
        while (fontSize > 1 && (panel.scrollHeight > panel.clientHeight || panel.scrollWidth > panel.clientWidth)) {
          panel.style.fontSize = `${--fontSize}px`;
        }
      });
    }

    function error(payload) {
      const mode = active?.mode;
      if (typeof payload === 'object' && payload !== null) {
        if (!active || payload.request_id !== active.request_id || !matches(capture())) return;
        payload = payload.error;
      }
      active = null;
      showError(String(payload), mode);
    }

    function dismissAnalysis() {
      if (active?.mode !== 'translation') active = null;
    }

    return { request, receive, error, dismissAnalysis };
  }
  return { createBlockTranslationController };
}));
