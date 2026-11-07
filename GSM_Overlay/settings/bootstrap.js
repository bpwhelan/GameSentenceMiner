// All classic scripts share the existing settings bindings. Initialize only
// after their definitions and the complete control markup have loaded.
// GSM_TAGUI: "Anki Tag Highlights" card on the Jiten page. The rules live in anki-tag-styles.json (main process).
function initializeAnkiTagStylesCard() {
  const page = document.querySelector('.settings-page[data-page="reading-jiten"]');
  if (!page || document.getElementById('ankiTagStylesGroup')) return;

  const MAX_RULES = 24;
  const LINE_STYLES = ['solid', 'dashed', 'dotted', 'double'];
  const POSITIONS = [['underline', 'Underline'], ['overline', 'Overline'], ['background', 'Background tint']];
  const TAG_RE = /^[^\s"()\\]{1,64}$/;
  const NEW_RULE = () => ({ tag: '', color: '#ff8800', style: 'solid', thickness: 2, position: 'underline', opacity: 0.3, enabled: true });

  const css = document.createElement('style');
  css.textContent = `
    #ankiTagStylesGroup .atr-list { display:flex; flex-direction:column; gap:8px; margin:10px 0; }
    #ankiTagStylesGroup .atr-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 10px;
      border:1px solid var(--gsm-border-subtle); border-radius:8px; background:var(--gsm-surface-1); }
    #ankiTagStylesGroup .atr-row.atr-off { opacity:.6; }
    #ankiTagStylesGroup .atr-tag { flex:1 1 150px; min-width:120px; display:flex; flex-direction:column; gap:2px; }
    #ankiTagStylesGroup .atr-row input[type="text"] { min-width:0; width:100%; }
    #ankiTagStylesGroup .atr-row select { min-width:96px; width:auto; }
    #ankiTagStylesGroup .atr-row input[type="number"] { width:68px; min-width:0; }
    #ankiTagStylesGroup .atr-meta { font-size:10.5px; color:var(--gsm-text-muted); }
    #ankiTagStylesGroup .atr-bad { color:var(--gsm-danger, #e5484d); }
    #ankiTagStylesGroup .atr-preview { display:inline-block; min-width:58px; padding:2px 8px; text-align:center;
      font-size:15px; border-radius:3px; color:var(--gsm-text-primary); }
    #ankiTagStylesGroup .atr-icon { padding:4px 8px; min-width:0; }
    #ankiTagStylesGroup .atr-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    #ankiTagStylesGroup .atr-status { font-size:11.5px; color:var(--gsm-text-muted); }
    #ankiTagStylesGroup .atr-empty { font-size:12px; color:var(--gsm-text-muted); padding:6px 2px; }
    #ankiTagStylesGroup .atr-marker { margin:14px 0 8px; padding:10px; border:1px solid var(--gsm-border-subtle); border-radius:8px; background:var(--gsm-surface-1); }
    #ankiTagStylesGroup .atr-marker-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
    #ankiTagStylesGroup .atr-marker-controls { display:flex; flex-wrap:wrap; align-items:flex-end; gap:10px; }
    #ankiTagStylesGroup .atr-marker-control { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--gsm-text-muted); }
    #ankiTagStylesGroup .atr-marker-control input[type="range"] { width:110px; min-width:90px; }
    #ankiTagStylesGroup .atr-marker-control input[type="color"] { width:42px; height:30px; padding:2px; }
    #ankiTagStylesGroup .atr-marker-control select { min-width:100px; }
    #ankiTagStylesGroup .atr-marker-preview { display:inline-flex; align-items:center; justify-content:center; min-width:70px; min-height:30px; padding:2px 10px; border-radius:4px; color:var(--gsm-text-primary); font-size:14px; }
    #ankiTagStylesGroup .atr-marker-status { font-size:11px; color:var(--gsm-text-muted); }
  `;
  document.head.appendChild(css);

  const group = document.createElement('div');
  group.className = 'setting-group';
  group.dataset.tab = 'reading';
  group.id = 'ankiTagStylesGroup';
  group.innerHTML = `
    <h4>Anki Tag Highlights</h4>
    <div class="hotkey-info setting-callout">
      Give words whose Anki note carries a tag (for example <b>unvoiced</b>) their own underline, overline or
      background tint in the overlay. If two rules use the same position on a word, the rule higher in the list wins;
      different positions combine. Anki wildcards work (<code>jlpt*</code>) and child tags (<code>tag::sub</code>) match.
      Changes save automatically and apply to all profiles.
    </div>
    <div class="atr-list" id="ankiTagRuleList"></div>
    <div class="atr-actions">
      <button type="button" class="guide-button" id="ankiTagAddRule">Add tag rule</button>
      <button type="button" class="guide-button" id="ankiTagOpenFile">Open advanced JSON</button>
      <span class="atr-status" id="ankiTagStatus"></span>
    </div>
    <div class="atr-marker" id="ankiDailyReviewMarker">
      <div class="atr-marker-head">
        <strong>Not reviewed today marker</strong>
        <label><input id="ankiDailyMarkerEnabled" type="checkbox"> Enabled</label>
      </div>
      <div class="hotkey-info">Style the marker shown on young review cards that have not been reviewed today. Due, mature and relearning cards are excluded.</div>
      <div class="atr-marker-controls">
        <label class="atr-marker-control">Color<input id="ankiDailyMarkerColor" type="color"></label>
        <label class="atr-marker-control">Position<select id="ankiDailyMarkerPosition"><option value="overline">Overline</option><option value="underline">Underline</option><option value="background">Background tint</option></select></label>
        <label class="atr-marker-control" id="ankiDailyMarkerStyleWrap">Line style<select id="ankiDailyMarkerStyle"><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option><option value="double">Double</option></select></label>
        <label class="atr-marker-control" id="ankiDailyMarkerThicknessWrap">Thickness <output id="ankiDailyMarkerThicknessValue">2 px</output><input id="ankiDailyMarkerThickness" type="range" min="1" max="8" step="1"></label>
        <label class="atr-marker-control" id="ankiDailyMarkerOpacityWrap">Background opacity <output id="ankiDailyMarkerOpacityValue">30%</output><input id="ankiDailyMarkerOpacity" type="range" min="0.05" max="1" step="0.05"></label>
        <span class="atr-marker-preview" id="ankiDailyMarkerPreview">日本語</span>
        <button type="button" class="guide-button" id="ankiDailyMarkerReset">Reset</button>
      </div>
      <div class="atr-marker-status" id="ankiDailyMarkerStatus" aria-live="polite"></div>
    </div>
    <div class="hotkey-info" id="ankiTagMeta"></div>`;
  page.appendChild(group);

  const listEl = group.querySelector('#ankiTagRuleList');
  const statusEl = group.querySelector('#ankiTagStatus');
  const metaEl = group.querySelector('#ankiTagMeta');

  const MARKER_DEFAULT = { enabled: true, color: '#d6a13a', style: 'dotted', thickness: 2, position: 'overline', opacity: 0.3 };
  const marker = { ...MARKER_DEFAULT };
  const markerControls = {
    enabled: group.querySelector('#ankiDailyMarkerEnabled'),
    color: group.querySelector('#ankiDailyMarkerColor'),
    position: group.querySelector('#ankiDailyMarkerPosition'),
    style: group.querySelector('#ankiDailyMarkerStyle'),
    thickness: group.querySelector('#ankiDailyMarkerThickness'),
    opacity: group.querySelector('#ankiDailyMarkerOpacity'),
  };
  const markerStyleWrap = group.querySelector('#ankiDailyMarkerStyleWrap');
  const markerThicknessWrap = group.querySelector('#ankiDailyMarkerThicknessWrap');
  const markerOpacityWrap = group.querySelector('#ankiDailyMarkerOpacityWrap');
  const markerThicknessValue = group.querySelector('#ankiDailyMarkerThicknessValue');
  const markerOpacityValue = group.querySelector('#ankiDailyMarkerOpacityValue');
  const markerPreview = group.querySelector('#ankiDailyMarkerPreview');
  const markerStatus = group.querySelector('#ankiDailyMarkerStatus');

  let model = [];
  let lastServerSig = '';
  let dirty = false;
  let saving = false;
  let editVersion = 0;
  let saveTimer = null;
  let statusTimer = null;

  const strip = (r) => ({ tag: r.tag, color: r.color, style: r.style, thickness: r.thickness,
    position: r.position, opacity: r.opacity, enabled: r.enabled });
  const sigOf = (rules) => JSON.stringify((rules || []).map(strip));
  const stripMarker = (value) => ({ enabled: value.enabled !== false, color: value.color, style: value.style,
    thickness: value.thickness, position: value.position, opacity: value.opacity });
  const sigPayload = (payload) => JSON.stringify({ rules: sigOf(payload.rules), marker: stripMarker(payload.dailyReviewMarker || MARKER_DEFAULT) });
  const clamp = (value, lo, hi, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };

  function setStatus(text, bad, autoClear) {
    clearTimeout(statusTimer);
    statusEl.textContent = text || '';
    statusEl.classList.toggle('atr-bad', !!bad);
    if (autoClear) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2500);
  }

  function applyPreview(el, rule) {
    el.style.borderTop = '0';
    el.style.borderBottom = '0';
    el.style.backgroundColor = 'transparent';
    if (rule.position === 'background') {
      const hex = /^#[0-9a-f]{6}$/i.test(rule.color) ? rule.color : '#888888';
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      el.style.backgroundColor = 'rgba(' + r + ',' + g + ',' + b + ',' + rule.opacity + ')';
    } else {
      const line = rule.thickness + 'px ' + rule.style + ' ' + rule.color;
      if (rule.position === 'overline') el.style.borderTop = line; else el.style.borderBottom = line;
    }
  }

  function colorWithAlpha(hex, alpha) {
    const value = hex.slice(1);
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function applyMarkerControls() {
    markerControls.enabled.checked = marker.enabled !== false;
    markerControls.color.value = /^#[0-9a-f]{6}$/i.test(marker.color) ? marker.color : MARKER_DEFAULT.color;
    markerControls.position.value = ['underline', 'overline', 'background'].includes(marker.position) ? marker.position : MARKER_DEFAULT.position;
    markerControls.style.value = ['solid', 'dashed', 'dotted', 'double'].includes(marker.style) ? marker.style : MARKER_DEFAULT.style;
    markerControls.thickness.value = String(clamp(marker.thickness, 1, 8, MARKER_DEFAULT.thickness));
    markerControls.opacity.value = String(clamp(marker.opacity, 0.05, 1, MARKER_DEFAULT.opacity));
    updateMarkerPreview();
  }

  function updateMarkerPreview() {
    const background = marker.position === 'background';
    markerStyleWrap.style.display = background ? 'none' : '';
    markerThicknessWrap.style.display = background ? 'none' : '';
    markerOpacityWrap.style.display = background ? '' : 'none';
    markerThicknessValue.textContent = `${marker.thickness} px`;
    markerOpacityValue.textContent = `${Math.round(marker.opacity * 100)}%`;
    markerPreview.style.borderTop = '0';
    markerPreview.style.borderBottom = '0';
    markerPreview.style.backgroundColor = '#303134';
    if (marker.enabled) {
      if (background) markerPreview.style.backgroundColor = colorWithAlpha(marker.color, marker.opacity);
      else {
        const line = `${marker.thickness}px ${marker.style} ${marker.color}`;
        if (marker.position === 'overline') markerPreview.style.borderTop = line;
        else markerPreview.style.borderBottom = line;
      }
    }
    markerPreview.style.opacity = marker.enabled ? '1' : '0.45';
    markerStatus.textContent = marker.enabled ? 'Applied to young cards not reviewed today.' : 'Marker disabled.';
  }

  function readMarkerControls() {
    marker.enabled = markerControls.enabled.checked;
    marker.color = markerControls.color.value.toLowerCase();
    marker.position = markerControls.position.value;
    marker.style = markerControls.style.value;
    marker.thickness = Math.round(clamp(markerControls.thickness.value, 1, 8, MARKER_DEFAULT.thickness));
    marker.opacity = Math.round(clamp(markerControls.opacity.value, 0.05, 1, MARKER_DEFAULT.opacity) * 100) / 100;
    updateMarkerPreview();
  }

  function scheduleSave() {
    dirty = true;
    editVersion++;
    clearTimeout(saveTimer);
    setStatus('Saving…');
    saveTimer = setTimeout(save, 500);
  }

  async function save() {
    if (model.some((r) => !TAG_RE.test(r.tag || ''))) {
      setStatus('Enter a tag name (no spaces) to save this rule.', true);
      return;
    }
    const version = editVersion;
    saving = true;
    let result;
    try {
      result = await ipcRenderer.invoke('gsm-anki-tag-rules-save', { rules: model.map(strip), dailyReviewMarker: stripMarker(marker) });
    } catch (error) {
      result = { ok: false, errors: ['could not reach the overlay: ' + String((error && error.message) || error).slice(0, 100)] };
    }
    saving = false;
    if (!result || !result.ok) {
      setStatus(((result && result.errors) || ['save failed']).join(' · '), true);
      return;
    }
    if (version === editVersion) dirty = false;
    lastServerSig = sigPayload(result);
    setStatus('Saved', false, true);
    updateMeta(result);
  }

  function updateMeta(payload) {
    const rows = listEl.querySelectorAll('.atr-row');
    (payload.rules || []).forEach((rule, i) => {
      const row = rows[i];
      if (!row || !model[i] || model[i].tag !== rule.tag) return;
      const meta = row.querySelector('.atr-meta');
      if (!meta) return;
      meta.classList.toggle('atr-bad', !!rule.error);
      meta.textContent = rule.error ? rule.error
        : (rule.enabled ? (rule.words == null ? 'waiting for Anki…' : rule.words + ' words') : 'off');
    });
    const notes = [];
    notes.push('Anki word states loaded: ' + (payload.states || 0) + (payload.source && payload.source !== 'none' ? ' (' + payload.source + ')' : ''));
    if (payload.refreshError) notes.push('last refresh error: ' + payload.refreshError);
    if (payload.errors && payload.errors.length) notes.push('rules file problems: ' + payload.errors.join('; '));
    if (payload.path) notes.push('file: ' + payload.path);
    metaEl.textContent = notes.join('  •  ');
  }

  function option(value, label, selected) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.selected = selected;
    return o;
  }

  function buildRow(rule, index) {
    const row = document.createElement('div');
    row.className = 'atr-row' + (rule.enabled ? '' : ' atr-off');

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled;
    enabled.title = 'Enabled';
    enabled.addEventListener('change', () => { rule.enabled = enabled.checked; row.classList.toggle('atr-off', !rule.enabled); scheduleSave(); });

    const tagCell = document.createElement('div');
    tagCell.className = 'atr-tag';
    const tag = document.createElement('input');
    tag.type = 'text';
    tag.placeholder = 'Anki tag, e.g. unvoiced';
    tag.value = rule.tag;
    tag.spellcheck = false;
    tag.addEventListener('input', () => { rule.tag = tag.value.trim(); scheduleSave(); });
    const meta = document.createElement('small');
    meta.className = 'atr-meta';
    tagCell.append(tag, meta);

    const color = document.createElement('input');
    color.type = 'color';
    color.value = rule.color;
    color.title = 'Color';
    color.addEventListener('input', () => { rule.color = color.value.toLowerCase(); applyPreview(preview, rule); scheduleSave(); });

    const lineStyle = document.createElement('select');
    lineStyle.title = 'Line type';
    LINE_STYLES.forEach((s) => lineStyle.append(option(s, s[0].toUpperCase() + s.slice(1), s === rule.style)));
    lineStyle.addEventListener('change', () => { rule.style = lineStyle.value; applyPreview(preview, rule); scheduleSave(); });

    const position = document.createElement('select');
    position.title = 'Where the highlight is drawn';
    POSITIONS.forEach(([value, label]) => position.append(option(value, label, value === rule.position)));

    const thickness = document.createElement('input');
    thickness.type = 'number';
    thickness.min = '1';
    thickness.max = '8';
    thickness.step = '1';
    thickness.title = 'Thickness (px)';
    thickness.value = String(rule.thickness);
    thickness.addEventListener('input', () => { rule.thickness = Math.round(clamp(thickness.value, 1, 8, 2)); applyPreview(preview, rule); scheduleSave(); });

    const opacity = document.createElement('input');
    opacity.type = 'number';
    opacity.min = '0.05';
    opacity.max = '1';
    opacity.step = '0.05';
    opacity.title = 'Opacity of the background tint';
    opacity.value = String(rule.opacity);
    opacity.addEventListener('input', () => { rule.opacity = Math.round(clamp(opacity.value, 0.05, 1, 0.3) * 100) / 100; applyPreview(preview, rule); scheduleSave(); });

    const preview = document.createElement('span');
    preview.className = 'atr-preview';
    preview.textContent = '食べる';
    preview.title = 'Preview';

    function syncPositionControls() {
      const bg = rule.position === 'background';
      lineStyle.style.display = bg ? 'none' : '';
      thickness.style.display = bg ? 'none' : '';
      opacity.style.display = bg ? '' : 'none';
    }
    position.addEventListener('change', () => { rule.position = position.value; syncPositionControls(); applyPreview(preview, rule); scheduleSave(); });
    syncPositionControls();
    applyPreview(preview, rule);

    const mkButton = (label, title, handler, disabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'guide-button atr-icon';
      b.textContent = label;
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', handler);
      return b;
    };
    const up = mkButton('↑', 'Move up (higher rules win)', () => { model.splice(index - 1, 0, model.splice(index, 1)[0]); render(); scheduleSave(); }, index === 0);
    const down = mkButton('↓', 'Move down', () => { model.splice(index + 1, 0, model.splice(index, 1)[0]); render(); scheduleSave(); }, index === model.length - 1);
    const remove = mkButton('✕', 'Delete rule', () => { model.splice(index, 1); render(); scheduleSave(); });

    row.append(enabled, tagCell, color, position, lineStyle, thickness, opacity, preview, up, down, remove);
    return row;
  }

  function render() {
    listEl.textContent = '';
    if (!model.length) {
      const empty = document.createElement('div');
      empty.className = 'atr-empty';
      empty.textContent = 'No tag rules yet. Add one to highlight words from tagged Anki notes.';
      listEl.append(empty);
    }
    model.forEach((rule, i) => listEl.append(buildRow(rule, i)));
    group.querySelector('#ankiTagAddRule').disabled = model.length >= MAX_RULES;
  }

  async function load(force) {
    if (!force && (dirty || saving)) return;
    let payload;
    try {
      payload = await ipcRenderer.invoke('gsm-anki-tag-rules-get');
    } catch (error) {
      setStatus('Could not load tag rules: ' + String((error && error.message) || error).slice(0, 100), true);
      return;
    }
    if (!payload || !Array.isArray(payload.rules)) return;
    const sig = sigPayload(payload);
    if (force || sig !== lastServerSig) {
      model = payload.rules.map((r) => ({ ...NEW_RULE(), ...strip(r) }));
      Object.assign(marker, MARKER_DEFAULT, payload.dailyReviewMarker || {});
      lastServerSig = sig;
      render();
      applyMarkerControls();
    }
    updateMeta(payload);
  }

  group.querySelector('#ankiTagAddRule').addEventListener('click', () => {
    if (model.length >= MAX_RULES) return;
    model.push(NEW_RULE());
    render();
    const inputs = listEl.querySelectorAll('.atr-row input[type="text"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
    setStatus('Enter a tag name (no spaces) to save this rule.', true);
    dirty = true;
  });
  group.querySelector('#ankiTagOpenFile').addEventListener('click', () => { void ipcRenderer.invoke('gsm-anki-tag-open-config'); });

  for (const control of Object.values(markerControls)) {
    control.addEventListener('input', () => { readMarkerControls(); scheduleSave(); });
    control.addEventListener('change', () => { readMarkerControls(); scheduleSave(); });
  }
  group.querySelector('#ankiDailyMarkerReset').addEventListener('click', () => {
    Object.assign(marker, MARKER_DEFAULT);
    applyMarkerControls();
    scheduleSave();
  });

  window.addEventListener('focus', () => { void load(false); });
  setInterval(() => { if (!document.hidden && group.offsetParent) void load(false); }, 5000);
  void load(true);
}
try { initializeAnkiTagStylesCard(); } catch (error) { console.error('[AnkiTagStyles]', error); }

// GSM_HOVERSTART: "Jiten Hover Lookup" option on the Jiten settings page.
function initializeJitenHoverOption() {
  const page = document.querySelector('.settings-page[data-page="reading-jiten"]');
  if (!page || document.getElementById('jitenHoverGroup')) return;
  const group = document.createElement('div');
  group.className = 'setting-group';
  group.dataset.tab = 'reading';
  group.id = 'jitenHoverGroup';
  group.innerHTML = `
    <h4>Jiten Hover Lookup</h4>
    <label>
      <span class="label-text">
        Where a hover lookup starts
        <div class="hotkey-info">Yomitan stops at the end of each Jiten word. <b>Whole word</b> starts at the word's first character. <b>Hovered character</b> starts under the cursor. Applies within a few seconds.</div>
      </span>
      <select id="jitenHoverStart">
        <option value="word">Whole word</option>
        <option value="cursor">Hovered character</option>
      </select>
    </label>`;
  page.appendChild(group);
  const select = group.querySelector('#jitenHoverStart');
  ipcRenderer.invoke('gsm-jiten-hover-get').then(result => {
    if (result && (result.hoverStart === 'word' || result.hoverStart === 'cursor')) select.value = result.hoverStart;
  }).catch(() => {});
  select.addEventListener('change', () => { void ipcRenderer.invoke('gsm-jiten-hover-set', { hoverStart: select.value }); });
}
try { initializeJitenHoverOption(); } catch (error) { console.error('[JitenHover]', error); }

// GSM_ANKI_POPUP_FLAGS_UI: manage local popup Blacklist / Never Forget flags.
function initializeAnkiPopupFlagsCard() {
  const page = document.querySelector('.settings-page[data-page="reading-jiten"]');
  if (!page || document.getElementById('ankiPopupFlagsGroup')) return;
  const style = document.createElement('style');
  style.textContent = `
    #ankiPopupFlagsGroup .apf-add { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:10px 0; }
    #ankiPopupFlagsGroup .apf-add input { flex:1 1 150px; min-width:130px; }
    #ankiPopupFlagsGroup .apf-add select { flex:0 1 150px; min-width:135px; }
    #ankiPopupFlagsGroup .apf-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:10px 0; }
    #ankiPopupFlagsGroup .apf-controls input { flex:1 1 180px; min-width:140px; }
    #ankiPopupFlagsGroup .apf-list {
      display:flex; flex-direction:column; gap:6px; margin:10px 0;
      min-height:88px; max-height:360px; max-height:min(360px, 48vh);
      overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable;
      padding:7px; border:1px solid var(--gsm-border-subtle); border-radius:8px;
      background:var(--gsm-surface-1);
    }
    #ankiPopupFlagsGroup .apf-row { display:flex; flex:0 0 auto; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 10px;
      border:1px solid var(--gsm-border-subtle); border-radius:8px; background:var(--gsm-surface-1); }
    #ankiPopupFlagsGroup .apf-word { flex:1 1 150px; min-width:120px; font-weight:600; overflow-wrap:anywhere; }
    #ankiPopupFlagsGroup .apf-meta, #ankiPopupFlagsGroup .apf-status { font-size:11.5px; color:var(--gsm-text-muted); }
    #ankiPopupFlagsGroup .apf-status.apf-bad { color:var(--gsm-danger, #e5484d); }
    #ankiPopupFlagsGroup .apf-empty { flex:0 0 auto; font-size:12px; color:var(--gsm-text-muted); padding:6px 2px; }
  `;
  document.head.appendChild(style);
  const group = document.createElement('div');
  group.className = 'setting-group';
  group.dataset.tab = 'reading';
  group.id = 'ankiPopupFlagsGroup';
  group.innerHTML = `
    <h4>Anki Popup Flags</h4>
    <div class="hotkey-info setting-callout">Words marked Blacklisted or Never Forget in the Jiten popup are saved locally by GSM. Add words here or remove existing flags. These flags do not change Anki notes or tags. Each spelling can have one flag; adding it again updates its flag and reading.</div>
    <form class="apf-add" id="ankiPopupFlagsAddForm">
      <input id="ankiPopupFlagsWord" type="text" maxlength="256" required autocomplete="off" spellcheck="false" placeholder="Word / spelling" aria-label="Word or spelling to flag">
      <input id="ankiPopupFlagsReading" type="text" maxlength="256" autocomplete="off" spellcheck="false" placeholder="Reading (optional)" aria-label="Reading, optional">
      <select id="ankiPopupFlagsType" aria-label="Flag type">
        <option value="blacklist">Blacklisted</option>
        <option value="neverForget">Never Forget</option>
      </select>
      <button type="submit" class="guide-button" id="ankiPopupFlagsAdd">Add word</button>
    </form>
    <div class="apf-controls">
      <input id="ankiPopupFlagsSearch" type="search" placeholder="Filter by word or reading" aria-label="Filter popup flags">
      <button type="button" class="guide-button" id="ankiPopupFlagsReload">Refresh list</button>
      <span class="apf-status" id="ankiPopupFlagsStatus" aria-live="polite"></span>
    </div>
    <div class="apf-list" id="ankiPopupFlagsList" role="list" aria-label="Saved Anki popup flags"></div>`;
  page.appendChild(group);
  const list = group.querySelector('#ankiPopupFlagsList');
  const search = group.querySelector('#ankiPopupFlagsSearch');
  const status = group.querySelector('#ankiPopupFlagsStatus');
  const addForm = group.querySelector('#ankiPopupFlagsAddForm');
  const wordInput = group.querySelector('#ankiPopupFlagsWord');
  const readingInput = group.querySelector('#ankiPopupFlagsReading');
  const flagInput = group.querySelector('#ankiPopupFlagsType');
  const addButton = group.querySelector('#ankiPopupFlagsAdd');
  let flags = [];
  const label = (flag) => flag === 'blacklist' ? 'Blacklisted' : 'Never Forget';
  function setStatus(message, bad = false) {
    status.textContent = message || '';
    status.classList.toggle('apf-bad', !!bad);
  }
  function render() {
    const query = search.value.normalize('NFKC').trim().toLocaleLowerCase();
    const matches = flags.filter((item) => !query || item.spelling.toLocaleLowerCase().includes(query)
      || item.reading.toLocaleLowerCase().includes(query));
    list.textContent = '';
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'apf-empty';
      empty.textContent = query ? 'No flags match this filter.' : 'No popup flags saved yet.';
      list.append(empty);
    }
    // Render the entire filtered result. The list container, not the settings page,
    // owns scrolling so every saved word remains accessible without a row-count cap.
    for (const item of matches) {
      const row = document.createElement('div');
      row.className = 'apf-row';
      row.setAttribute('role', 'listitem');
      const word = document.createElement('span');
      word.className = 'apf-word';
      word.textContent = item.spelling;
      const meta = document.createElement('span');
      meta.className = 'apf-meta';
      meta.textContent = [item.reading, label(item.flag)].filter(Boolean).join(' · ');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'guide-button';
      remove.textContent = 'Remove flag';
      remove.setAttribute('aria-label', 'Remove ' + label(item.flag) + ' flag from ' + item.spelling);
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await ipcRenderer.invoke('gsm-anki-popup-set-flag', {
            term: item.spelling, reading: item.reading, flag: item.flag, action: 'remove',
          });
          flags = flags.filter((candidate) => candidate.spelling !== item.spelling);
          render();
          setStatus('Flag removed');
        } catch (error) {
          remove.disabled = false;
          setStatus('Could not remove flag: ' + String((error && error.message) || error).slice(0, 120), true);
        }
      });
      row.append(word, meta, remove);
      list.append(row);
    }
    status.dataset.count = String(matches.length);
  }
  async function load() {
    setStatus('Loading…');
    try {
      const payload = await ipcRenderer.invoke('gsm-anki-popup-flags-list');
      flags = Array.isArray(payload?.flags) ? payload.flags : [];
      render();
      setStatus(flags.length + (flags.length === 1 ? ' flag' : ' flags'));
    } catch (error) {
      setStatus('Could not load flags: ' + String((error && error.message) || error).slice(0, 120), true);
    }
  }
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const term = wordInput.value.normalize('NFKC').trim();
    if (!term) {
      setStatus('Enter a word or spelling first.', true);
      wordInput.focus();
      return;
    }
    addButton.disabled = true;
    setStatus('Saving…');
    try {
      const flag = flagInput.value;
      await ipcRenderer.invoke('gsm-anki-popup-set-flag', {
        term,
        reading: readingInput.value.trim(),
        flag,
        action: 'add',
      });
      wordInput.value = '';
      readingInput.value = '';
      search.value = '';
      await load();
      setStatus('Saved ' + term + ' as ' + label(flag));
      wordInput.focus();
    } catch (error) {
      setStatus('Could not save flag: ' + String((error && error.message) || error).slice(0, 120), true);
    } finally {
      addButton.disabled = false;
    }
  });
  search.addEventListener('input', render);
  group.querySelector('#ankiPopupFlagsReload').addEventListener('click', () => { void load(); });
  window.addEventListener('focus', () => { void load(); });
  ipcRenderer.on('gsm-anki-popup-state-changed', () => { void load(); });
  void load();
}
try { initializeAnkiPopupFlagsCard(); } catch (error) { console.error('[AnkiPopupFlags]', error); }


GSMSettingsHome.render();
initializeSettingBindings();
syncDisableInteractionSubOptionsUi();
updateControllerActivationFieldState();
updateTokenizerBackendFieldState();
initializeSettingsTabs();
renderOverlayPresetCards();
void applyPlatformSpecifics();
initializeSettingsInputs();
