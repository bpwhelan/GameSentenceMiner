const { ipcRenderer } = require("electron");

const overlayLayer = document.getElementById("overlayLayer");
const stage = document.getElementById("stage");
const controlPanel = document.getElementById("controlPanel");
const toggleHudButton = document.getElementById("toggleHudButton");
const helperStatus = document.getElementById("helperStatus");
const emptyState = document.getElementById("emptyState");
const offsetXInput = document.getElementById("offsetXInput");
const offsetYInput = document.getElementById("offsetYInput");
const offsetXPercent = document.getElementById("offsetXPercent");
const offsetYPercent = document.getElementById("offsetYPercent");
const boxCountDisplay = document.getElementById("boxCountDisplay");
const viewportDisplay = document.getElementById("viewportDisplay");
const previewMeta = document.getElementById("previewMeta");
const previewText = document.getElementById("previewText");
const resetButton = document.getElementById("resetButton");
const cancelButton = document.getElementById("cancelButton");
const saveButton = document.getElementById("saveButton");

const MOVEMENT_KEYS = new Map([
  ["ArrowUp", { dx: 0, dy: -1 }],
  ["ArrowDown", { dx: 0, dy: 1 }],
  ["ArrowLeft", { dx: -1, dy: 0 }],
  ["ArrowRight", { dx: 1, dy: 0 }],
  ["KeyW", { dx: 0, dy: -1 }],
  ["KeyS", { dx: 0, dy: 1 }],
  ["KeyA", { dx: -1, dy: 0 }],
  ["KeyD", { dx: 1, dy: 0 }],
]);

const state = {
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
  offsetXPercent: 0,
  offsetYPercent: 0,
  offsetXPixels: 0,
  offsetYPixels: 0,
  items: [],
  previewLines: [],
  fallbackSentence: "",
  hasLoadedInitialOffset: false,
  activeMovementKeys: new Set(),
  keyMovementTimer: null,
  pointerMovementTimer: null,
  pointerVector: null,
};

function clampPercentValue(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, value));
}

function normalizeAxisCoordinate(value, axis) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  const dimension = axis === "x" ? state.viewportWidth : state.viewportHeight;
  const absolute = Math.abs(numeric);

  if (absolute <= 1.5) {
    return numeric;
  }

  if (absolute <= 100.5) {
    return numeric / 100;
  }

  return dimension > 0 ? numeric / dimension : 0;
}

function normalizeBoundingRect(rect) {
  if (!rect || typeof rect !== "object") {
    return null;
  }

  const x1 = normalizeAxisCoordinate(rect.x1 ?? rect.left ?? rect.x ?? rect.x0, "x");
  const y1 = normalizeAxisCoordinate(rect.y1 ?? rect.top ?? rect.y ?? rect.y0, "y");
  const x2 = normalizeAxisCoordinate(rect.x3 ?? rect.x2 ?? rect.right ?? rect.x4, "x");
  const y2 = normalizeAxisCoordinate(rect.y3 ?? rect.y2 ?? rect.bottom ?? rect.y4, "y");

  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return null;
  }

  const left = Math.max(0, Math.min(1, Math.min(x1, x2)));
  const top = Math.max(0, Math.min(1, Math.min(y1, y2)));
  const right = Math.max(0, Math.min(1, Math.max(x1, x2)));
  const bottom = Math.max(0, Math.min(1, Math.max(y1, y2)));

  return {
    left,
    top,
    width: Math.max(0.001, right - left),
    height: Math.max(0.001, bottom - top),
  };
}

function collectTextItems(node, context, preferredLineIndex = null) {
  if (node === null || node === undefined) {
    return;
  }

  if (typeof node === "string") {
    const trimmed = node.trim();
    if (trimmed && !context.fallbackSentence) {
      context.fallbackSentence = trimmed;
    }
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((entry) => collectTextItems(entry, context, preferredLineIndex));
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  if (typeof node.sentence === "string" && node.sentence.trim() && !context.fallbackSentence) {
    context.fallbackSentence = node.sentence.trim();
  }

  if (Array.isArray(node.words) && node.words.length > 0) {
    const lineIndex = preferredLineIndex ?? context.nextLineIndex++;
    node.words.forEach((word) => collectTextItems(word, context, lineIndex));
    return;
  }

  if (Array.isArray(node.lines) && node.lines.length > 0) {
    node.lines.forEach((line, index) => collectTextItems(line, context, preferredLineIndex ?? index));
  }

  if (Array.isArray(node.data) && node.data.length > 0) {
    node.data.forEach((entry) => collectTextItems(entry, context, preferredLineIndex));
  }

  if (Array.isArray(node.items) && node.items.length > 0) {
    node.items.forEach((entry) => collectTextItems(entry, context, preferredLineIndex));
  }

  const text = String(node.text ?? node.word ?? node.value ?? "").trim();
  const rect = normalizeBoundingRect(node.bounding_rect ?? node.rect ?? node.bounds);

  if (!text || !rect) {
    return;
  }

  context.items.push({
    text,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    lineIndex: preferredLineIndex,
  });
}

function groupPreviewLines(items) {
  if (!items.length) {
    return [];
  }

  const sortedItems = [...items].sort((a, b) => {
    if (a.lineIndex !== null && b.lineIndex !== null && a.lineIndex !== b.lineIndex) {
      return a.lineIndex - b.lineIndex;
    }

    const verticalDelta = a.top - b.top;
    if (Math.abs(verticalDelta) > 0.01) {
      return verticalDelta;
    }

    return a.left - b.left;
  });

  const lines = [];

  sortedItems.forEach((item) => {
    const existingLine = lines.find((line) => {
      if (item.lineIndex !== null && line.lineIndex !== null) {
        return item.lineIndex === line.lineIndex;
      }

      return Math.abs(line.top - item.top) <= Math.max(line.height, item.height) * 0.6;
    });

    if (existingLine) {
      existingLine.entries.push(item);
      existingLine.top = Math.min(existingLine.top, item.top);
      existingLine.height = Math.max(existingLine.height, item.height);
      if (existingLine.lineIndex === null && item.lineIndex !== null) {
        existingLine.lineIndex = item.lineIndex;
      }
      return;
    }

    lines.push({
      lineIndex: item.lineIndex,
      top: item.top,
      height: item.height,
      entries: [item],
    });
  });

  return lines
    .sort((a, b) => {
      if (a.lineIndex !== null && b.lineIndex !== null && a.lineIndex !== b.lineIndex) {
        return a.lineIndex - b.lineIndex;
      }
      return a.top - b.top;
    })
    .map((line) => line.entries.sort((a, b) => a.left - b.left).map((entry) => entry.text).join(" ").trim())
    .filter(Boolean);
}

function normalizeTextPayload(textData) {
  const context = {
    items: [],
    fallbackSentence: "",
    nextLineIndex: 0,
  };

  collectTextItems(textData, context);

  return {
    items: context.items,
    fallbackSentence: context.fallbackSentence,
    previewLines: groupPreviewLines(context.items),
  };
}

function getSafeViewportWidth() {
  return Math.max(window.innerWidth || state.viewportWidth || 1, 1);
}

function getSafeViewportHeight() {
  return Math.max(window.innerHeight || state.viewportHeight || 1, 1);
}

function percentToPixelsX(percent) {
  return (getSafeViewportWidth() * percent) / 100;
}

function percentToPixelsY(percent) {
  return (getSafeViewportHeight() * percent) / 100;
}

function pixelsToPercentX(pixels) {
  return (pixels / getSafeViewportWidth()) * 100;
}

function pixelsToPercentY(pixels) {
  return (pixels / getSafeViewportHeight()) * 100;
}

function syncPercentFromPixels() {
  state.offsetXPercent = clampPercentValue(pixelsToPercentX(state.offsetXPixels));
  state.offsetYPercent = clampPercentValue(pixelsToPercentY(state.offsetYPixels));
}

function applyLayerTransform() {
  overlayLayer.style.transform = `translate(${state.offsetXPixels}px, ${state.offsetYPixels}px)`;
}

function formatPercent(value) {
  return `${value.toFixed(6)}%`;
}

function roundPixelInputValue(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function updateOffsetDisplay() {
  offsetXInput.value = String(roundPixelInputValue(state.offsetXPixels));
  offsetYInput.value = String(roundPixelInputValue(state.offsetYPixels));
  offsetXPercent.textContent = formatPercent(state.offsetXPercent);
  offsetYPercent.textContent = formatPercent(state.offsetYPercent);
  viewportDisplay.textContent = `${Math.round(getSafeViewportWidth())} x ${Math.round(getSafeViewportHeight())}`;
}

function setOffsetsFromPercent(percentX, percentY) {
  state.offsetXPercent = clampPercentValue(Number(percentX) || 0);
  state.offsetYPercent = clampPercentValue(Number(percentY) || 0);
  state.offsetXPixels = percentToPixelsX(state.offsetXPercent);
  state.offsetYPixels = percentToPixelsY(state.offsetYPercent);
  applyLayerTransform();
  updateOffsetDisplay();
}

function setOffsetsFromPixels(pixelX, pixelY) {
  state.offsetXPixels = Number.isFinite(pixelX) ? pixelX : 0;
  state.offsetYPixels = Number.isFinite(pixelY) ? pixelY : 0;
  syncPercentFromPixels();
  applyLayerTransform();
  updateOffsetDisplay();
}

function moveByPixels(dx, dy) {
  setOffsetsFromPixels(state.offsetXPixels + dx, state.offsetYPixels + dy);
}

function getMovementStep() {
  return state.activeMovementKeys.has("ShiftLeft") || state.activeMovementKeys.has("ShiftRight") ? 10 : 1;
}

function applyKeyboardMovement() {
  const step = getMovementStep();
  let dx = 0;
  let dy = 0;

  state.activeMovementKeys.forEach((code) => {
    const vector = MOVEMENT_KEYS.get(code);
    if (!vector) {
      return;
    }
    dx += vector.dx * step;
    dy += vector.dy * step;
  });

  if (dx !== 0 || dy !== 0) {
    moveByPixels(dx, dy);
  }
}

function stopKeyboardMovement() {
  if (state.keyMovementTimer !== null) {
    clearInterval(state.keyMovementTimer);
    state.keyMovementTimer = null;
  }
}

function startKeyboardMovement() {
  if (state.keyMovementTimer !== null) {
    return;
  }

  state.keyMovementTimer = setInterval(() => {
    if (![...state.activeMovementKeys].some((code) => MOVEMENT_KEYS.has(code))) {
      stopKeyboardMovement();
      return;
    }
    applyKeyboardMovement();
  }, 16);
}

function stopPointerMovement() {
  if (state.pointerMovementTimer !== null) {
    clearInterval(state.pointerMovementTimer);
    state.pointerMovementTimer = null;
  }
  state.pointerVector = null;
}

function startPointerMovement(dx, dy) {
  stopPointerMovement();
  state.pointerVector = { dx, dy };
  moveByPixels(dx, dy);
  state.pointerMovementTimer = setInterval(() => {
    if (!state.pointerVector) {
      stopPointerMovement();
      return;
    }
    moveByPixels(state.pointerVector.dx, state.pointerVector.dy);
  }, 60);
}

function renderOverlay() {
  overlayLayer.innerHTML = "";

  if (state.items.length === 0 && !state.fallbackSentence) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  const fragment = document.createDocumentFragment();

  if (state.items.length > 0) {
    state.items.forEach((item) => {
      const token = document.createElement("div");
      const widthPixels = Math.max(item.width * getSafeViewportWidth(), 6);
      const heightPixels = Math.max(item.height * getSafeViewportHeight(), 8);
      const fontSize = Math.max(10, Math.min(96, Math.round(heightPixels * 0.86)));

      token.className = "overlay-token";
      token.textContent = item.text;
      token.style.left = `${item.left * 100}%`;
      token.style.top = `${item.top * 100}%`;
      token.style.minWidth = `${Math.round(widthPixels)}px`;
      token.style.minHeight = `${Math.round(heightPixels)}px`;
      token.style.fontSize = `${fontSize}px`;
      fragment.appendChild(token);
    });
  } else {
    const sentenceToken = document.createElement("div");
    sentenceToken.className = "overlay-token overlay-token--sentence";
    sentenceToken.textContent = state.fallbackSentence;
    fragment.appendChild(sentenceToken);
  }

  overlayLayer.appendChild(fragment);
  applyLayerTransform();
}

function updateStatusCopy() {
  if (state.items.length > 0) {
    helperStatus.textContent = "Live OCR boxes loaded. Move the bright overlay until it sits directly on the game text.";
    previewMeta.textContent = `${state.items.length} boxes`;
    previewText.textContent = state.previewLines.length
      ? state.previewLines.join("\n")
      : "OCR boxes detected, but no grouped preview lines were produced.";
    boxCountDisplay.textContent = String(state.items.length);
    return;
  }

  if (state.fallbackSentence) {
    helperStatus.textContent = "Plain text fallback loaded. This is visible, but OCR boxes were not available for this sample.";
    previewMeta.textContent = "Plain text fallback";
    previewText.textContent = state.fallbackSentence;
    boxCountDisplay.textContent = "0";
    return;
  }

  helperStatus.textContent = "Waiting for live OCR text. Leave this helper open and trigger text capture in your game.";
  previewMeta.textContent = "Waiting for text...";
  previewText.textContent = "Waiting for live OCR text...";
  boxCountDisplay.textContent = "0";
}

function applyPayload(payload) {
  const nextViewportWidth = Number(payload?.windowBounds?.width);
  const nextViewportHeight = Number(payload?.windowBounds?.height);

  if (Number.isFinite(nextViewportWidth) && nextViewportWidth > 0) {
    state.viewportWidth = nextViewportWidth;
  } else {
    state.viewportWidth = getSafeViewportWidth();
  }

  if (Number.isFinite(nextViewportHeight) && nextViewportHeight > 0) {
    state.viewportHeight = nextViewportHeight;
  } else {
    state.viewportHeight = getSafeViewportHeight();
  }

  const normalized = normalizeTextPayload(payload?.textData ?? null);
  state.items = normalized.items;
  state.previewLines = normalized.previewLines;
  state.fallbackSentence = normalized.fallbackSentence;

  renderOverlay();
  updateStatusCopy();

  const settings = payload?.settings || {};
  if (!state.hasLoadedInitialOffset) {
    setOffsetsFromPercent(settings.offsetX || 0, settings.offsetY || 0);
    state.hasLoadedInitialOffset = true;
  } else {
    setOffsetsFromPercent(state.offsetXPercent, state.offsetYPercent);
  }
}

function saveOffset() {
  ipcRenderer.send("save-offset", {
    offsetX: Number(state.offsetXPercent.toFixed(6)),
    offsetY: Number(state.offsetYPercent.toFixed(6)),
  });
  window.close();
}

function resetOffset() {
  setOffsetsFromPercent(0, 0);
}

function closeHelper() {
  window.close();
}

function focusStage() {
  stage.focus({ preventScroll: true });
}

function isTypingTarget(target) {
  if (!target) {
    return false;
  }

  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || target.isContentEditable;
}

function toggleHud() {
  const collapsed = document.body.classList.toggle("panel-collapsed");
  toggleHudButton.textContent = collapsed ? "Show Panel" : "Hide Panel";
  toggleHudButton.setAttribute("aria-expanded", String(!collapsed));
}

function handlePixelInputCommit() {
  const nextX = Number.parseFloat(offsetXInput.value);
  const nextY = Number.parseFloat(offsetYInput.value);
  setOffsetsFromPixels(
    Number.isFinite(nextX) ? nextX : state.offsetXPixels,
    Number.isFinite(nextY) ? nextY : state.offsetYPixels
  );
}

toggleHudButton.addEventListener("click", () => {
  toggleHud();
  focusStage();
});

stage.addEventListener("pointerdown", () => {
  focusStage();
});

controlPanel.addEventListener("pointerdown", (event) => {
  if (event.target === controlPanel) {
    focusStage();
  }
});

offsetXInput.addEventListener("change", handlePixelInputCommit);
offsetYInput.addEventListener("change", handlePixelInputCommit);

offsetXInput.addEventListener("blur", handlePixelInputCommit);
offsetYInput.addEventListener("blur", handlePixelInputCommit);

resetButton.addEventListener("click", () => {
  resetOffset();
  focusStage();
});

cancelButton.addEventListener("click", closeHelper);
saveButton.addEventListener("click", saveOffset);

document.querySelectorAll(".nudge-button[data-dx]").forEach((button) => {
  const dx = Number(button.dataset.dx);
  const dy = Number(button.dataset.dy);

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startPointerMovement(dx, dy);
    focusStage();
  });

  ["pointerup", "pointerleave", "pointercancel"].forEach((eventName) => {
    button.addEventListener(eventName, stopPointerMovement);
  });
});

["pointerup", "pointercancel"].forEach((eventName) => {
  document.addEventListener(eventName, stopPointerMovement);
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") {
    event.preventDefault();
    saveOffset();
    return;
  }

  if (event.code === "Enter" || event.code === "NumpadEnter") {
    event.preventDefault();
    saveOffset();
    return;
  }

  if (event.code === "Escape") {
    event.preventDefault();
    closeHelper();
    return;
  }

  if (!isTypingTarget(document.activeElement) && event.code === "KeyR") {
    event.preventDefault();
    resetOffset();
    return;
  }

  if (!isTypingTarget(document.activeElement) && event.code === "Tab") {
    event.preventDefault();
    toggleHud();
    return;
  }

  if (!MOVEMENT_KEYS.has(event.code) && event.code !== "ShiftLeft" && event.code !== "ShiftRight") {
    return;
  }

  if (isTypingTarget(document.activeElement)) {
    return;
  }

  event.preventDefault();

  const wasPresent = state.activeMovementKeys.has(event.code);
  state.activeMovementKeys.add(event.code);

  if (!wasPresent && MOVEMENT_KEYS.has(event.code)) {
    applyKeyboardMovement();
  }

  startKeyboardMovement();
});

document.addEventListener("keyup", (event) => {
  if (!state.activeMovementKeys.has(event.code)) {
    return;
  }

  state.activeMovementKeys.delete(event.code);

  if (![...state.activeMovementKeys].some((code) => MOVEMENT_KEYS.has(code))) {
    stopKeyboardMovement();
  }
});

window.addEventListener("blur", () => {
  state.activeMovementKeys.clear();
  stopKeyboardMovement();
  stopPointerMovement();
});

window.addEventListener("resize", () => {
  state.viewportWidth = getSafeViewportWidth();
  state.viewportHeight = getSafeViewportHeight();
  renderOverlay();
  setOffsetsFromPercent(state.offsetXPercent, state.offsetYPercent);
});

ipcRenderer.on("text-data", (_event, payload) => {
  applyPayload(payload || {});
});

updateOffsetDisplay();
updateStatusCopy();
focusStage();
