const { prepareTextLines } = require('./block_detection');

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
  return String(value || '').normalize('NFKC').trim()
    .replace(/^(?:[▶▷►●○・]\s*|\d{1,2}[.)．、]\s*)/u, '').replace(/\s/gu, '');
}

function choiceLines(data) {
  if (!Array.isArray(data) || data.length > 500) return [];
  return prepareTextLines(data).flatMap(line => {
    if (typeof line?.text !== 'string' || line.text.length > 100 || /[\r\n]/u.test(line.text) || line.isVertical) return [];
    const box = line.bounding_rect;
    if (!box || !['x1', 'x3', 'y1', 'y3'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key]) && box[key] >= 0 && box[key] <= 1)) return [];
    const height = box.y3 - box.y1;
    if (height <= 0 || height > 0.09 || box.x3 <= box.x1) return [];
    return [{ text: normalizeChoice(line.text), ...box, height, center: (box.x1 + box.x3) / 2 }];
  });
}

function findChoice(data, expected) {
  const target = normalizeChoice(expected);
  if (!target) return null;
  const lines = choiceLines(data);
  const matches = lines.filter(line => line.text === target);
  if (matches.length !== 1) return null;
  const match = matches[0];
  // Deliberately miss lower dialogue-box choices rather than interpreting a
  // speaker and a short dialogue line as a menu. Manual controls cover these.
  if (match.y3 > 0.74) return null;
  const short = [...target].length <= 4;
  const peers = lines.filter(line => {
    if (line === match || !line.text || line.text === target || line.y3 > 0.74) return false;
    const height = Math.max(line.height, match.height);
    const gap = Math.max(line.y1 - match.y3, match.y1 - line.y3);
    const aligned = short
      ? Math.abs(line.center - match.center) < 0.025
      : Math.min(Math.abs(line.center - match.center), Math.abs(line.x1 - match.x1)) < 0.035;
    return aligned && Math.min(line.height, match.height) / height > 0.65
      && gap >= height * (short ? 1.2 : 0.8) && gap <= height * 7;
  });
  return peers.length ? { text: target, options: [target, ...peers.map(line => line.text)] } : null;
}

const isSaveControl = line => /セーブ|ロード|上書き|保存先|^(?:(?:quick|auto)?(?:save|load)(?:game|data|slot)?|overwrite)$/iu.test(line.text);

class GuideTracker {
  constructor(steps, index = 0) {
    this.steps = steps;
    this.index = this.choiceAfterSave(Number.isInteger(index) && index >= 0 && index <= steps.length ? index : 0);
    this.tentative = false;
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
  resetDetection() { this.detected = false; this.armed = null; this.blockedOptions = null; this.suspendedPresenceId = null; }
  suspendDetection() {
    // Retain the hint across a temporary hide, but require new menu evidence
    // before disappearance can advance. Keep a manual advance's duplicate guard.
    if (this.armed) this.suspendedPresenceId = this.armed.presenceId;
    this.armed = null;
  }
  jump(index) {
    if (!Number.isInteger(index) || index < 0 || index > this.steps.length) throw new Error('Choose a step within this route.');
    index = this.choiceAfterSave(index);
    const blocked = index > this.index ? this.armed?.options : null;
    this.index = index;
    this.tentative = false;
    this.resetDetection();
    this.blockedOptions = blocked;
  }
  next() { this.jump(Math.min(this.index + 1, this.steps.length)); }
  back() { this.jump(Math.max(0, this.startIndex - 1)); }
  observe(message, now = Date.now(), autoAdvance = true) {
    if (!this.current || this.current.kind !== 'choice') return;
    if (message?.type === 'overlay_clear') { this.resetDetection(); return; }
    if (message?.type === 'ocr_text_invalidated') {
      if (this.armed && (!message.presence_id || message.presence_id === this.armed.presenceId)) {
        this.armed.invalidatedAt = now;
        this.detected = false;
      }
      if (message.presence_id && message.presence_id === this.suspendedPresenceId) this.detected = false;
      return;
    }
    if (message?.type === 'ocr_text_revalidated' && message.presence_id
      && message.presence_id === (this.armed?.presenceId || this.suspendedPresenceId)
      && message.payload?.presence_id === message.presence_id && message.payload.type === 'word_coordinates') {
      message = message.payload;
    }
    if (message?.type !== 'word_coordinates' || message.supplemental || !Array.isArray(message.data) || !message.data.length) return;
    if (this.blockedOptions) {
      const lines = choiceLines(message.data);
      if (message.is_final === true && lines.length && !lines.some(line => this.blockedOptions.includes(line.text))) this.blockedOptions = null;
      return;
    }
    const match = findChoice(message.data, this.current.text);
    if (match) {
      const previous = this.armed;
      this.armed = {
        ...match, since: previous?.since ?? now, presenceId: message.presence_id,
        stable: message.is_final === true || !!previous && now - previous.since >= 200,
        saveControls: this.saveInstructions.length ? choiceLines(message.data).filter(isSaveControl) : [],
      };
      this.detected = true;
      this.suspendedPresenceId = null;
      return;
    }
    const armed = this.armed;
    const lines = choiceLines(message.data);
    if (!armed) {
      if (message.is_final === true && lines.length) this.resetDetection();
      return;
    }
    if (armed.invalidatedAt && now - armed.invalidatedAt > 15000) { this.resetDetection(); return; }
    if (!lines.length || lines.some(line => armed.options.includes(line.text))) return;
    if (armed.presenceId && armed.presenceId === message.presence_id) return;
    // Saving at the choice is not selecting an answer. New save/load headings
    // disarm progression until the menu returns; persistent game buttons do not.
    if (this.saveInstructions.length && message.is_final === true && lines.some(line => isSaveControl(line)
      && !armed.saveControls.some(control => control.text === line.text && Math.abs(control.center - line.center) < 0.03 && Math.abs(control.y1 - line.y1) < 0.03))) {
      this.resetDetection();
      return;
    }
    // A blank fade, OCR retries, and a cursor highlight disappearing are not a
    // selection. Require a fresh final text frame with the entire menu gone.
    if (message.is_final !== true || !armed.stable || now - armed.since < 900) return;
    this.resetDetection();
    if (autoAdvance) {
      this.next();
      this.tentative = true; // Always reversible; OCR cannot verify which option was clicked.
    }
  }
}

module.exports = { SITE, RAW, parseGuideUrl, validateGuide, validateRoute, stepKind, normalizeChoice, findChoice, GuideTracker };
