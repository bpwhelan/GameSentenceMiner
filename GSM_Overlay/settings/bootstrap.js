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
      <button type="button" class="guide-button" id="ankiTagOpenFile">Open rules file</button>
      <span class="atr-status" id="ankiTagStatus"></span>
    </div>
    <div class="hotkey-info" id="ankiTagMeta"></div>`;
  page.appendChild(group);

  const listEl = group.querySelector('#ankiTagRuleList');
  const statusEl = group.querySelector('#ankiTagStatus');
  const metaEl = group.querySelector('#ankiTagMeta');

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
      result = await ipcRenderer.invoke('gsm-anki-tag-rules-save', { rules: model.map(strip) });
    } catch (error) {
      result = { ok: false, errors: ['could not reach the overlay: ' + String((error && error.message) || error).slice(0, 100)] };
    }
    saving = false;
    if (!result || !result.ok) {
      setStatus(((result && result.errors) || ['save failed']).join(' · '), true);
      return;
    }
    if (version === editVersion) dirty = false;
    lastServerSig = sigOf(result.rules);
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
    const sig = sigOf(payload.rules);
    if (force || sig !== lastServerSig) {
      model = payload.rules.map((r) => ({ ...NEW_RULE(), ...strip(r) }));
      lastServerSig = sig;
      render();
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
    #ankiPopupFlagsGroup .apf-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:10px 0; }
    #ankiPopupFlagsGroup .apf-controls input { flex:1 1 180px; min-width:140px; }
    #ankiPopupFlagsGroup .apf-list { display:flex; flex-direction:column; gap:6px; margin:10px 0; }
    #ankiPopupFlagsGroup .apf-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 10px;
      border:1px solid var(--gsm-border-subtle); border-radius:8px; background:var(--gsm-surface-1); }
    #ankiPopupFlagsGroup .apf-word { flex:1 1 150px; min-width:120px; font-weight:600; overflow-wrap:anywhere; }
    #ankiPopupFlagsGroup .apf-meta, #ankiPopupFlagsGroup .apf-status { font-size:11.5px; color:var(--gsm-text-muted); }
    #ankiPopupFlagsGroup .apf-status.apf-bad { color:var(--gsm-danger, #e5484d); }
    #ankiPopupFlagsGroup .apf-empty { font-size:12px; color:var(--gsm-text-muted); padding:6px 2px; }
  `;
  document.head.appendChild(style);
  const group = document.createElement('div');
  group.className = 'setting-group';
  group.dataset.tab = 'reading';
  group.id = 'ankiPopupFlagsGroup';
  group.innerHTML = `
    <h4>Anki Popup Flags</h4>
    <div class="hotkey-info setting-callout">Words marked Blacklisted or Never Forget in the Jiten popup are saved locally by GSM. Review the list here and remove flags when they are no longer needed. These flags do not change Anki notes or tags.</div>
    <div class="apf-controls">
      <input id="ankiPopupFlagsSearch" type="search" placeholder="Filter by word or reading" aria-label="Filter popup flags">
      <button type="button" class="guide-button" id="ankiPopupFlagsReload">Refresh list</button>
      <span class="apf-status" id="ankiPopupFlagsStatus" aria-live="polite"></span>
    </div>
    <div class="apf-list" id="ankiPopupFlagsList"></div>`;
  page.appendChild(group);
  const list = group.querySelector('#ankiPopupFlagsList');
  const search = group.querySelector('#ankiPopupFlagsSearch');
  const status = group.querySelector('#ankiPopupFlagsStatus');
  let flags = [];
  const label = (flag) => flag === 'blacklist' ? 'Blacklisted' : 'Never Forget';
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
    const shown = matches.slice(0, 300);
    for (const item of shown) {
      const row = document.createElement('div');
      row.className = 'apf-row';
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
          flags = flags.filter((candidate) => !(candidate.spelling === item.spelling && candidate.flag === item.flag));
          render();
          status.textContent = 'Flag removed';
          status.classList.remove('apf-bad');
        } catch (error) {
          remove.disabled = false;
          status.textContent = 'Could not remove flag: ' + String((error && error.message) || error).slice(0, 120);
          status.classList.add('apf-bad');
        }
      });
      row.append(word, meta, remove);
      list.append(row);
    }
    status.dataset.count = String(matches.length);
    if (matches.length > 300) {
      const note = document.createElement('div');
      note.className = 'apf-empty';
      note.textContent = 'Showing 300 of ' + matches.length + ' flags. Filter the list to find more.';
      list.append(note);
    }
  }
  async function load() {
    status.textContent = 'Loading…';
    status.classList.remove('apf-bad');
    try {
      const payload = await ipcRenderer.invoke('gsm-anki-popup-flags-list');
      flags = Array.isArray(payload?.flags) ? payload.flags : [];
      render();
      status.textContent = flags.length + (flags.length === 1 ? ' flag' : ' flags');
    } catch (error) {
      status.textContent = 'Could not load flags: ' + String((error && error.message) || error).slice(0, 120);
      status.classList.add('apf-bad');
    }
  }
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
