const { prepareTextLines, detectTextBlocks } = require('./block_detection');

const SITE = 'https://kanjieater.github.io/VN-Guide/';
const RAW = 'https://raw.githubusercontent.com/kanjieater/VN-Guide/main/';
const safeId = value => typeof value === 'string' && /^[\p{L}\p{N}_-]{1,160}$/u.test(value);

// Only the public VN-Guide format is supported. Never execute guide HTML or
// follow URLs supplied by a manifest to fetch route data.
function parseGuideUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Paste a specific game URL from kanjieater’s VN-Guide.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an official HTTPS VN-Guide URL.');
  let prefix;
  if (url.origin === new URL(SITE).origin) prefix = '/VN-Guide/';
  else if (url.origin === 'https://raw.githubusercontent.com') prefix = '/kanjieater/VN-Guide/main/';
  else if (url.origin === 'https://github.com') {
    prefix = /^\/kanjieater\/VN-Guide\/(tree|blob)\/main\//.exec(url.pathname)?.[0];
  }
  if (!prefix || !url.pathname.startsWith(prefix)) throw new Error('Only kanjieater’s VN-Guide URLs are supported.');
  const parts = url.pathname.slice(prefix.length).split('/').filter(Boolean).map(part => decodeURIComponent(part));
  if (!safeId(parts[0]) || parts.length > 2 || (parts[1] && !/^(index\.html|guide\.json|route_[\p{L}\p{N}_-]+\.json)$/u.test(parts[1]))) {
    throw new Error('Open a game in VN-Guide, then paste that game’s URL here.');
  }
  const nav = new URLSearchParams(url.hash.slice(1));
  const routeId = nav.get('route') || /^route_(.+)\.json$/.exec(parts[1] || '')?.[1] || '';
  if (routeId && !safeId(routeId)) throw new Error('Invalid route in the guide URL.');
  const step = /^\d+$/.test(nav.get('step') || '') ? Number(nav.get('step')) : null;
  const slug = parts[0];
  return { slug, routeId, step: Number.isSafeInteger(step) ? step : null, pageUrl: `${SITE}${encodeURIComponent(slug)}/`, baseUrl: `${RAW}${encodeURIComponent(slug)}/` };
}

function validateGuide(data) {
  if (!data || typeof data.title !== 'string' || !Array.isArray(data.routes) || !data.routes.length || data.routes.length > 200) {
    throw new Error('This file is not a VN-Guide game manifest.');
  }
  const seen = new Set();
  const routes = data.routes.map(route => {
    if (!safeId(route?.id) || seen.has(route.id) || typeof route.title !== 'string') throw new Error('The guide contains an invalid or duplicate route.');
    seen.add(route.id);
    return { id: route.id, title: route.title.slice(0, 300), reviewed: route.reviewed === true };
  });
  return { title: data.title.slice(0, 300), routes, target: typeof data.guide_target?.label === 'string' ? data.guide_target.label.slice(0, 300) : '' };
}

function stepKind(step) {
  const text = String(step.simpleJp || '').normalize('NFKC');
  // isLoad is only a structural detour marker upstream; ordinary loads often
  // lack it and can start with セーブ. Check load before save.
  if (step.isLoad === true || /ロード|\bload\b/iu.test(text)) return 'load';
  if (/セーブ|\bsave\b/iu.test(text)) return 'save';
  return 'choice';
}

function validateRoute(data) {
  if (!Array.isArray(data) || !data.length || data.length > 5000) throw new Error('This route does not contain a supported step list.');
  return data.map(step => {
    if (!step || typeof step.simpleJp !== 'string' || !step.simpleJp.trim() || step.simpleJp.length > 2000) {
      throw new Error('A route step is missing its Japanese instruction. Progress was not changed.');
    }
    return { text: step.simpleJp.trim(), kind: stepKind(step) };
  });
}

function normalizeChoice(value) {
  // Ignore punctuation and symbol variants (including OCR's dash-like glyphs)
  // only when comparing text. Keep letters such as the Japanese vowel mark ー.
  return String(value || '').normalize('NFKC').trim()
    .replace(/^(?:[▶▷►●○・]\s*|\d{1,2}[.)．、]\s*)/u, '').replace(/[\p{P}\p{S}\s]/gu, '');
}

function choiceLines(data) {
  if (!Array.isArray(data) || data.length > 500) return [];
  const prepared = prepareTextLines(data).filter(line => {
    const box = line?.bounding_rect;
    return typeof line?.text === 'string' && box
      && ['x1', 'x3', 'y1', 'y3'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key]) && box[key] >= 0 && box[key] <= 1)
      && box.x3 > box.x1 && box.y3 > box.y1;
  });
  const blocks = detectTextBlocks(prepared);
  return prepared.flatMap((line, index) => {
    if (line.text.length > 100 || /[\r\n]/u.test(line.text) || line.isVertical) return [];
    const box = line.bounding_rect;
    const height = box.y3 - box.y1;
    if (height > 0.09) return [];
    const blockId = blocks.lineBlocks.get(index);
    const boundary = blocks.blockBoundaries.get(blockId);
    const isolated = boundary?.start === index && boundary?.end === index && blocks.blockMetadata.get(blockId)?.role === 'text';
    return [{ text: normalizeChoice(line.text), ...box, height, center: (box.x1 + box.x3) / 2, isolated }];
  });
}

function choiceSimilarity(observed, target) {
  if (!observed || !target) return 0;
  if (observed === target) return 1;
  const a = [...observed], b = [...target];
  const length = Math.max(a.length, b.length);
  // Short answers and large length differences are too easy to confuse. Limit
  // longer choices to one or two OCR insertions, deletions, or substitutions.
  const budget = Math.min(2, Math.max(1, Math.floor(length * 0.12)));
  if (Math.min(a.length, b.length) < 8 || length > 100 || Math.abs(a.length - b.length) > budget) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    }
    if (Math.min(...next) > budget) return 0;
    row = next;
  }
  return row[b.length] <= budget ? 1 - row[b.length] / length : 0;
}

const containsOption = (options, text) => (options || []).some(option => choiceSimilarity(text, option) > 0);

function findChoice(data, expected, { allowFuzzy = true, requireMenu = false } = {}) {
  const target = normalizeChoice(expected);
  if (!target) return null;
  const lines = choiceLines(data);
  const exact = lines.filter(line => line.text === target);
  const matches = exact.length ? exact : allowFuzzy ? lines.filter(line => line.isolated && choiceSimilarity(line.text, target) > 0) : [];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const short = [...target].length <= 4;
  const peers = lines.filter(line => {
    if (line === match || !line.text || line.text === target || isSaveControl(line) || !exact.length && !line.isolated) return false;
    const height = Math.max(line.height, match.height);
    const gap = Math.max(line.y1 - match.y3, match.y1 - line.y3);
    const aligned = short
      ? Math.abs(line.center - match.center) < 0.025
      : Math.min(Math.abs(line.center - match.center), Math.abs(line.x1 - match.x1)) < 0.035;
    return aligned && Math.min(line.height, match.height) / height > 0.65
      && gap >= height * (short ? 1.2 : 0.8) && gap <= height * 7;
  });
  const menu = peers.length > 0;
  if (requireMenu && !menu) return null;
  if (!menu && (!match.isolated || [...target].length < 8)) return null;
  const similarity = choiceSimilarity(match.text, target);
  // Position is a small confidence bonus, never a requirement. Isolation and
  // text similarity must stand on their own even when there are menu peers.
  const central = Math.abs(match.center - 0.5) < 0.2 && Math.abs((match.y1 + match.y3) / 2 - 0.5) < 0.25;
  const confidence = similarity + (menu ? 0.03 : 0) + (central ? 0.02 : 0);
  if (similarity < 1 && (!match.isolated || confidence < 0.9)) return null;
  return { text: target, observed: match.text, exact: similarity === 1, menu,
    options: [...new Set([target, match.text, ...peers.map(line => line.text)])] };
}

const isSaveControl = line => /セーブ|ロード|上書き|保存先|^(?:(?:quick|auto)?(?:save|load)(?:game|data|slot)?|overwrite)$/iu.test(line.text);
const LOOK_AHEAD_CHOICES = 3;

class GuideTracker {
  constructor(steps, index = 0) {
    this.steps = steps;
    this.index = this.choiceAfterSave(Number.isInteger(index) && index >= 0 && index <= steps.length ? index : 0);
    this.tentative = false;
    this.recoveredFrom = null;
    this.resetDetection();
  }
  get current() { return this.steps[this.index] || null; }
  get complete() { return this.index === this.steps.length; }
  get startIndex() {
    let start = this.index;
    if (this.current?.kind === 'choice') while (this.steps[start - 1]?.kind === 'save') start -= 1;
    return start;
  }
  get saveInstructions() { return this.steps.slice(this.startIndex, this.index).map(step => step.text); }
  choiceAfterSave(index) {
    let next = index;
    while (this.steps[next]?.kind === 'save') next += 1;
    // Keep the original indexes for links and saved progress. A save belongs to
    // the following choice, but must never be carried across a load or route end.
    return this.steps[next]?.kind === 'choice' ? next : index;
  }
  get rememberedChoice() { return this.detected && !this.armed; }
  resetDetection() {
    this.detected = false;
    this.armed = null;
    this.blockedOptions = null;
    this.pendingLineId = null;
    this.pendingAhead = null;
    this.suspendedPresenceId = null;
    this.suspendedLineId = null;
    this.suspendedOptions = null;
  }
  suspendDetection() {
    // Retain the hint across a temporary hide, but require new menu evidence
    // before disappearance can advance. Keep a manual advance's duplicate guard.
    if (this.armed) {
      this.suspendedPresenceId = this.armed.presenceId;
      this.suspendedLineId = this.armed.lineId;
      this.suspendedOptions = this.armed.options;
    }
    this.armed = null;
    this.pendingLineId = null;
    this.pendingAhead = null;
  }
  findAheadChoice(data, lines) {
    // An option still present in the current menu, or a save confirmation, must
    // not be interpreted as a later guide step merely because its text matches.
    if (lines.some(line => line.text === normalizeChoice(this.current.text) || isSaveControl(line) && line.y3 <= 0.74)) return null;
    const matches = [];
    const limit = this.saveInstructions.length ? 1 : LOOK_AHEAD_CHOICES;
    let index = this.index + 1;
    for (let count = 0; count < limit && index < this.steps.length; count += 1) {
      const carriesSave = this.steps[index].kind === 'save';
      if (carriesSave) index = this.choiceAfterSave(index);
      if (this.steps[index]?.kind !== 'choice') break;
      const match = findChoice(data, this.steps[index].text, { allowFuzzy: false, requireMenu: true });
      if (match) matches.push({ index, match });
      // The save can be shown with its next choice, but never skipped past it.
      if (carriesSave) break;
      index += 1;
    }
    return matches.length === 1 ? matches[0] : null;
  }
  jump(index) {
    if (!Number.isInteger(index) || index < 0 || index > this.steps.length) throw new Error('Choose a step within this route.');
    index = this.choiceAfterSave(index);
    const blocked = index > this.index ? this.armed?.options : null;
    this.index = index;
    this.tentative = false;
    this.recoveredFrom = null;
    this.resetDetection();
    this.blockedOptions = blocked;
  }
  next() { this.jump(Math.min(this.index + 1, this.steps.length)); }
  back() { this.jump(this.recoveredFrom ?? Math.max(0, this.startIndex - 1)); }
  observe(message, now = Date.now(), autoAdvance = true) {
    if (!this.current || this.current.kind !== 'choice') return;
    if (message?.type === 'game_text') {
      if (typeof message.text !== 'string' || message.text.length > 20000) return;
      const options = message.text.split(/\r?\n/u).map(normalizeChoice).filter(Boolean);
      if (!options.length) return;
      if (this.blockedOptions) {
        if (options.some(text => containsOption(this.blockedOptions, text))) return;
        this.blockedOptions = null;
      }
      const target = normalizeChoice(this.current.text);
      const matches = options.filter(text => text === target);
      // Text without coordinates can reveal only the current exact instruction.
      // It cannot establish a menu, recover missed steps, or arm progression.
      if (matches.length === 1 && !options.some(text => isSaveControl({ text }))) {
        if (this.armed?.source !== 'ocr') {
          this.armed = { text: target, options, source: 'text', since: now, stable: false, saveControls: [] };
          this.detected = true;
        }
      } else if (this.armed?.source === 'text') {
        this.armed = null;
        this.detected = false;
      }
      return;
    }
    if (message?.type === 'overlay_clear') {
      this.pendingAhead = null;
      if (!message.line_id) this.resetDetection();
      else {
        // The backend clears boxes before scanning each new text line. Hide the
        // old hint, but keep its evidence until that scan confirms the menu left.
        this.pendingLineId = message.line_id;
        if (this.armed?.source !== 'text') this.detected = false;
        if (this.armed) this.armed.invalidatedAt ??= now;
      }
      return;
    }
    if (message?.type === 'ocr_text_invalidated') {
      if (this.armed && this.armed.source !== 'text' && (!message.presence_id || message.presence_id === this.armed.presenceId)) {
        this.pendingAhead = null;
        this.armed.invalidatedAt = now;
        this.detected = false;
      }
      if (message.presence_id && message.presence_id === this.suspendedPresenceId) this.detected = false;
      return;
    }
    const revalidated = message?.type === 'ocr_text_revalidated';
    if (revalidated && message.presence_id
      && message.presence_id === (this.armed?.presenceId || this.suspendedPresenceId)
      && message.payload?.presence_id === message.presence_id && message.payload.type === 'word_coordinates') {
      message = message.payload;
    }
    if (message?.type !== 'word_coordinates' || message.supplemental || !Array.isArray(message.data)) return;
    if (!message.data.length) { this.pendingAhead = null; return; }
    if (this.pendingLineId) {
      const staleLine = message.line_id && message.line_id !== this.pendingLineId;
      const stalePresence = this.armed?.lineId !== this.pendingLineId
        && message.presence_id && message.presence_id === this.armed?.presenceId;
      if (revalidated || staleLine || stalePresence) return;
    }
    const lines = choiceLines(message.data);
    if (this.blockedOptions) {
      if (message.is_final === true && lines.length && !lines.some(line => containsOption(this.blockedOptions, line.text))) this.blockedOptions = null;
      // A distinct menu may be the only scan of the next choice. Once it clears
      // the old-menu guard, use that same frame to detect the current step.
      else return;
    }
    let match = findChoice(message.data, this.current.text);
    if (match && !match.exact && this.steps.some(step => step.kind === 'choice'
      && normalizeChoice(step.text) === match.observed)) match = null;
    const previousPresence = this.armed?.presenceId || this.suspendedPresenceId;
    const previousLine = this.armed?.lineId || this.suspendedLineId;
    let stableAhead = false;
    if (!match && autoAdvance && !revalidated && (!previousPresence || previousPresence !== message.presence_id)) {
      const ahead = this.findAheadChoice(message.data, lines);
      if (ahead && !containsOption(this.armed?.options || this.suspendedOptions, ahead.match.text)) {
        // While skipping, OCR can keep retrying an old hooked sentence for
        // several seconds, even as another menu appears under the same line ID.
        // Two consistent scans of the immediate next menu can confirm that
        // transition, but only after a stable visual menu armed the old choice.
        const adjacent = this.armed?.source === 'ocr' && this.armed.stable
          && ahead.index === this.choiceAfterSave(this.index + 1)
          && (this.armed.invalidatedAt == null || now - this.armed.invalidatedAt <= 15000);
        const signature = JSON.stringify([ahead.index, [...ahead.match.options].sort()]);
        if (adjacent) {
          if (this.pendingAhead?.signature !== signature) this.pendingAhead = { signature, since: now };
          stableAhead = now - this.pendingAhead.since >= 200;
        } else this.pendingAhead = null;
        if (stableAhead || message.is_final === true && (!previousLine || previousLine !== message.line_id)) {
          const from = this.index;
          this.jump(ahead.index);
          this.blockedOptions = null; // This fresh, distinct menu already proves the old one was left.
          this.tentative = true;
          this.recoveredFrom = from;
          match = ahead.match;
        }
      } else this.pendingAhead = null;
    } else this.pendingAhead = null;
    if (match) {
      this.pendingAhead = null;
      const previous = this.armed;
      this.armed = {
        ...match, source: 'ocr',
        since: previous?.source === 'ocr' && previous.menu === match.menu ? previous.since : now,
        presenceId: message.presence_id, lineId: message.line_id,
        stable: stableAhead || previous?.stable === true || match.menu && (message.is_final === true || previous?.menu && now - previous.since >= 200),
        saveControls: lines.filter(isSaveControl),
      };
      this.detected = true;
      if (message.is_final === true) this.pendingLineId = null;
      this.suspendedPresenceId = null;
      this.suspendedLineId = null;
      this.suspendedOptions = null;
      return;
    }
    const armed = this.armed;
    if (!armed) {
      if (message.is_final === true && lines.length) {
        const options = this.suspendedOptions;
        this.resetDetection();
        if (lines.some(line => containsOption(options, line.text))) this.suspendedOptions = options;
      }
      return;
    }
    if (armed.source === 'text') return;
    if (armed.invalidatedAt != null && now - armed.invalidatedAt > 15000) { this.resetDetection(); return; }
    if (!lines.length || lines.some(line => containsOption(armed.options, line.text))) return;
    if (armed.presenceId && armed.presenceId === message.presence_id) return;
    if (armed.lineId && armed.lineId === message.line_id) return;
    // Saving at the choice is not selecting an answer. New save/load headings
    // disarm progression until the menu returns; persistent game buttons do not.
    if (message.is_final === true && lines.some(line => isSaveControl(line)
      && !armed.saveControls.some(control => control.text === line.text && Math.abs(control.center - line.center) < 0.03 && Math.abs(control.y1 - line.y1) < 0.03))) {
      this.resetDetection();
      return;
    }
    // A blank fade, OCR retries, and a cursor highlight disappearing are not a
    // selection. Require a fresh final text frame with the entire menu gone.
    // A different text-event ID is stronger evidence than a minimum dwell time;
    // fast readers may select a fully scanned choice in well under a second.
    if (message.is_final === true && !armed.stable) { this.resetDetection(); return; }
    const freshLine = armed.lineId && message.line_id && armed.lineId !== message.line_id;
    if (message.is_final !== true || !armed.stable || !freshLine && now - armed.since < 900) return;
    this.resetDetection();
    if (autoAdvance) {
      this.next();
      this.tentative = true; // Always reversible; OCR cannot verify which option was clicked.
      // This frame may already contain the next menu with a small OCR error,
      // which exact-only look-ahead cannot recover. Use it once more for the
      // new instruction so the old confirmation never consumes its only scan.
      this.observe(message, now, false);
    }
  }
}

module.exports = { SITE, RAW, parseGuideUrl, validateGuide, validateRoute, stepKind, normalizeChoice, findChoice, GuideTracker };
