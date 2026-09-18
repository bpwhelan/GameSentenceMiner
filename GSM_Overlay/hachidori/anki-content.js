// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };

  const FEEDBACK_PRIORITY = { info: 0, success: 1, warning: 2, error: 3 };
  function syncFeedbackSurface(feedback) {
    const visible = [...feedback.querySelectorAll(".gsm-hoshidicts-anki-control")]
      .filter(control => !control.hidden);
    feedback.hidden = visible.length === 0;
    if (visible.length === 0) {
      delete feedback.dataset.kind;
      return;
    }
    feedback.dataset.kind = visible.reduce((kind, control) => {
      const next = control.dataset.kind || "info";
      return FEEDBACK_PRIORITY[next] > FEEDBACK_PRIORITY[kind] ? next : kind;
    }, "info");
  }
  function syncFeedback(record) {
    if (!record.control) return;
    record.control.hidden = record.hidden || (record.badge.hidden && record.output.textContent === "");
    syncFeedbackSurface(record.feedback);
  }
  function setStatus(record, value, kind = "info") {
    text(record.output, value);
    record.control.dataset.kind = kind;
    syncFeedback(record);
  }
  function setMiningButtonState(record, state, message = "") {
    const button = record.add;
    button.dataset.state = state;
    const actionTitle = message || {
      checking: "Checking Anki card status",
      ready: "Mine to Anki",
      "add-duplicate": "Add duplicate to Anki",
      overwrite: "Overwrite note in Anki",
      "view-existing": "View existing notes in Anki",
      mining: "Adding note",
      success: "Note added",
      error: "Could not add note",
      duplicate: "Note already exists",
      unavailable: "Anki mining is unavailable",
    }[state] || "Mine to Anki";
    const title = record.custom && !message ? `${record.label}: ${actionTitle}` : actionTitle;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-busy", String(state === "checking" || state === "mining"));
    button.dataset.action = views(record) ? "view" : "add";
    if (record.custom) {
      let label = button.querySelector(".gsm-hoshidicts-text-action-label");
      if (!label) {
        label = button.ownerDocument.createElement("span");
        label.className = "gsm-hoshidicts-text-action-label";
        button.replaceChildren(label);
      }
      text(label, record.label);
      return;
    }
    const iconName = {
      ready: "add",
      "add-duplicate": "document-add",
      overwrite: "document-edit",
      "view-existing": "book-search",
      checking: "arrow-clockwise",
      mining: "arrow-sync",
      success: "book-search",
      error: "error-circle",
      unavailable: "subtract",
    }[state] || "subtract";
    const icon = button.ownerDocument.createElement("span");
    icon.className = "gsm-hoshidicts-mine-icon hd-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.dataset.icon = iconName;
    button.replaceChildren(icon);
  }
  // The one Anki button opens Anki instead of adding once there is a note to
  // show: the note it wrote, the write it could not confirm, or the duplicates
  // that block adding.
  function views(record) {
    return record.terminal || (record.decision?.state === "duplicate" && record.decision.canAdd === false);
  }
  function disabled(record) {
    if (!record.add) return;
    record.add.disabled = record.busy
      || (!record.terminal && (record.needsCheck || (!record.decision?.canAdd && !views(record))));
  }
  function payload(record) {
    return {
      ...record.group.getRequest(record.result),
      configKey: record.configKey,
      templateId: record.templateId,
    };
  }
  function decisionState(value) {
    if (value.action === "overwrite" && value.canAdd) return "overwrite";
    if (value.state === "duplicate") return value.canAdd ? "add-duplicate" : "view-existing";
    if (value.state === "invalid" || value.state === "error") return "error";
    return "ready";
  }
  function showControls(record, value) {
    record.hidden = !value;
    if (record.add) record.add.hidden = !value;
    syncFeedback(record);
  }
  function removeControls(record) {
    if (record?.add && !record.custom) record.add.remove();
    if (record?.add && record.custom) {
      record.add.removeEventListener("mousedown", record.onMouseDown);
      record.add.removeEventListener("click", record.onClick);
      record.add.disabled = true;
      delete record.add.dataset.state;
      delete record.add.dataset.action;
      record.add.removeAttribute("aria-busy");
    }
    record?.control?.remove();
    if (record?.feedback) syncFeedbackSurface(record.feedback);
  }
  function reusableRecord(record, group, spec) {
    return record?.group === group && record.result === spec.item.result
      && record.custom === spec.custom && record.templateId === spec.templateId;
  }
  function createRecord(group, spec) {
    const { item, binding, custom, templateId, label, add } = spec;
    return {
      ...item,
      binding,
      group,
      custom,
      templateId,
      label,
      ...(add ? { add } : {}),
      configKey: null,
      busy: false,
      terminal: false,
      decision: null,
      viewChecked: false,
      needsCheck: true,
      captureJobId: null,
    };
  }
  function updateRecord(record, spec) {
    Object.assign(record, {
      actions: spec.item.actions,
      feedback: spec.item.feedback,
      result: spec.item.result,
      label: spec.label,
    });
    if (spec.custom) setMiningButtonState(record, record.add.dataset.state || "checking");
  }
  function captureBadge(record, state = "") {
    if (!record.badge) return;
    const capture = record.decision?.capture;
    record.badge.hidden = !capture;
    if (!capture) {
      text(record.badge, "");
      syncFeedback(record);
      return;
    }
    const labels = [capture.sourceLabel, capture.partial ? "Partial" : "", state].filter(Boolean);
    text(record.badge, labels.join(" · "));
    syncFeedback(record);
  }
  function decision(record, value) {
    record.decision = value;
    if (!record.terminal && !record.busy) {
      const state = decisionState(value);
      setMiningButtonState(record, state, state === "view-existing" ? "" : value.error || "");
      setStatus(record, value.error || "", value.error ? "error" : "info");
    }
    captureBadge(record);
    disabled(record);
  }
  function uncertain(record, error) {
    record.terminal = true;
    setMiningButtonState(record, "error", "Check Anki before trying again");
    setStatus(record, error, "error");
  }
  function readyCaptureRequest(record, request, requirements, assets) {
    captureBadge(record);
    const unavailable = [...(request.captureUnavailable ?? [])];
    if (requirements.includeAnimation && !assets?.animation) unavailable.push("animation");
    if (requirements.includeAudio && !assets?.audio) unavailable.push("audio");
    return { ...request, captureJobId: record.captureJobId, captureUnavailable: unavailable };
  }
  function captureProgress(record, status) {
    if (status.state === "finishing") {
      captureBadge(record, "Finishing clip");
      setStatus(record, "Finishing clip…");
    } else {
      captureBadge(record);
      const progress = status.total > 0 ? ` ${status.progress}/${status.total}` : "";
      setStatus(record, `Encoding captured media${progress}…`);
    }
  }
  function restartChecks(records) {
    for (const record of records) {
      if (record.terminal) continue;
      record.viewChecked = false;
      record.needsCheck = true;
      record.decision = null;
      if (record.add) setMiningButtonState(record, "checking");
    }
  }
  function cachedViewRequest(record) {
    return { request: {
      term: {
        expression: record.result.term.expression,
        reading: record.result.term.reading,
      },
      templateId: record.templateId,
    } };
  }
  function cachedView(value) {
    return value?.cached === true && value.state === "duplicate"
      && value.canAdd === false && Array.isArray(value.noteIds) && value.noteIds.length > 0;
  }
  function checkedConfigKey(configKey, result) {
    if (typeof result?.configKey !== "string") return { configKey, changed: false };
    if (configKey !== null && result.configKey !== configKey) return { configKey, changed: true };
    return { configKey: result.configKey, changed: false };
  }
  function createAnkiController({
    send,
    capture = send,
    onChange,
    // The page's own overlays are hidden for a viewport screenshot and restored
    // afterwards; without a host to hide, the screenshot is just taken.
    conceal = during => during(),
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }) {
    const owners = new Map(), bound = new WeakMap();
    let enabled = false, settingsKey = "", checks = Promise.resolve();
    let primaryTemplateId = "default";
    let templateIds = new Set(["default"]);
    let customButtonTemplates = new Map();
    const live = group => enabled && owners.get(group.owner) === group && !group.popup.hidden && group.isCurrent();
    const boundHere = record => bound.get(record.binding) === record && record.binding.isConnected;
    const current = record => live(record.group) && boundHere(record);
    const needsCheck = record => boundHere(record) && record.needsCheck && !record.busy && !record.terminal;
    function available(records, value, error = "") {
      for (const record of records) {
        const show = value || record.custom || record.terminal || cachedView(record.decision);
        if (show && record.actions.isConnected) controls(record);
        if (record.control) showControls(record, show);
        if (!value && !show) record.needsCheck = false;
        if (!value && record.custom) {
          record.needsCheck = false;
          setMiningButtonState(record, "unavailable", error || "This Anki Template is unavailable.");
          setStatus(record, error || "This Anki Template is unavailable.", "error");
        }
      }
    }
    async function requestCachedView(record) {
      record.viewChecked = true;
      try {
        return await send("hd_anki_view", cachedViewRequest(record));
      } catch {
        return null;
      }
    }
    function applyCachedView(group, record, result) {
      if (!cachedView(result)) return;
      record.needsCheck = false;
      controls(record);
      showControls(record, true);
      decision(record, result);
      onChange(group.owner);
    }
    async function checkCachedViews(group, records, owns) {
      const configKeys = new Map();
      for (const record of records) {
        if (!owns()) return { configKeys, changed: [] };
        if (!needsCheck(record) || record.viewChecked) continue;
        const result = await requestCachedView(record);
        if (result === null || !owns() || !boundHere(record)) continue;
        const configKey = configKeys.get(record.templateId) ?? null;
        const checked = checkedConfigKey(configKey, result);
        if (checked.changed) {
          return {
            configKeys,
            changed: records.filter(candidate => candidate.templateId === record.templateId),
          };
        }
        if (checked.configKey !== null) configKeys.set(record.templateId, checked.configKey);
        record.configKey = checked.configKey;
        applyCachedView(group, record, result);
      }
      return { configKeys, changed: [] };
    }
    async function checkRecords(records, owns) {
      for (const record of records) {
        if (!owns()) return;
        if (!needsCheck(record)) continue;
        record.needsCheck = false;
        try {
          const result = await send("hd_anki_preflight", { request: payload(record) });
          if (owns() && boundHere(record)) decision(record, result);
        } catch (error) {
          if (owns() && boundHere(record)) decision(record, { state: "error", canAdd: false, error: error.message });
        }
      }
    }
    function recordsByTemplate(records) {
      const byTemplate = new Map();
      for (const record of records) {
        if (!byTemplate.has(record.templateId)) byTemplate.set(record.templateId, []);
        byTemplate.get(record.templateId).push(record);
      }
      return byTemplate;
    }
    async function checkTemplateRecords(group, templateId, records, configKeys, owns) {
      const status = await send("hd_anki_status", { templateId });
      if (!owns()) return;
      const cachedKey = configKeys.get(templateId) ?? null;
      if (status.available && cachedKey !== null && status.configKey !== cachedKey) {
        restartChecks(records);
        return;
      }
      for (const record of records) record.configKey = status.configKey;
      available(records, status.available, status.error);
      if (!status.available) return;
      onChange(group.owner);
      await checkRecords(records, owns);
    }
    async function checkGroup(group) {
      const epoch = group.epoch;
      const owns = () => live(group) && epoch === group.epoch;
      try {
        if (!owns()) return;
        const missing = group.records.filter(record => needsCheck(record) && !templateIds.has(record.templateId));
        available(missing, false, "The selected Anki Template is no longer available.");
        const configured = group.records.filter(record => templateIds.has(record.templateId));
        const cached = await checkCachedViews(group, configured, owns);
        if (!owns()) return;
        if (cached.changed.length > 0) {
          restartChecks(cached.changed);
          return;
        }
        if (!group.records.some(needsCheck)) return;
        const byTemplate = recordsByTemplate(group.records.filter(needsCheck));
        for (const [templateId, records] of byTemplate) {
          await checkTemplateRecords(group, templateId, records, cached.configKeys, owns);
          if (!owns()) return;
        }
      } catch (error) {
        if (owns()) available(group.records.filter(needsCheck), false, error.message);
      } finally {
        group.queued = false;
        if (live(group)) {
          group.records.forEach(disabled);
          onChange(group.owner);
          refresh(group);
        }
      }
    }
    function refresh(group, all = false) {
      if (all) for (const record of group.records) {
        record.viewChecked = record.terminal;
        record.needsCheck = !record.terminal;
      }
      group.records.forEach(record => {
        if (needsCheck(record)) {
          // Readiness belongs to this result, not to the whole popup's queue.
          record.decision = null;
          if (enabled) {
            controls(record);
            showControls(record, true);
            setMiningButtonState(record, "checking");
          }
        }
        disabled(record);
      });
      if (!live(group) || group.queued || !group.records.some(needsCheck)) return;
      group.queued = true;
      const operation = () => checkGroup(group);
      checks = checks.then(operation, operation);
    }
    function refreshAll() {
      for (const group of owners.values()) refresh(group, true);
    }
    async function discardScreenshot(record) {
      if (!record.screenshot) return;
      const { token } = record.screenshot;
      record.screenshot = null;
      try { await send("hd_anki_screenshot_discard", { request: { token } }); } catch { /* A restarted worker holds nothing. */ }
    }
    async function cancelCapture(record) {
      if (!record.captureJobId) return;
      try { await capture("hd_capture_cancel", { jobId: record.captureJobId }); } catch { /* Stop/expiry already cleaned it up. */ }
      record.captureJobId = null;
    }
    async function handleSubmissionFailure(record, error, writeSent, owns) {
      if (!writeSent) {
        // Nothing was sent, so the picture this submission took is nobody's.
        await discardScreenshot(record);
      } else if (!error.responseReceived) {
        uncertain(record, `The write could not be confirmed. Check Anki before trying again. ${error.message}`);
        return;
      } else {
        // A worker reply confirms that no Anki mutation was sent. Release the
        // request-owned export even after its popup owner has retired.
        await cancelCapture(record);
        await discardScreenshot(record);
      }
      if (!owns()) return;
      setMiningButtonState(record, decisionState(record.decision));
      setStatus(record, `Could not add: ${error.message}`, "error");
    }
    // One viewport screenshot for this submission, taken with Hachidori's own
    // overlays hidden. A capture or upload that fails is a warning carried with
    // the note's outcome: the field renders empty and the note still goes in.
    async function prepareScreenshot(record, request, owns) {
      record.screenshotWarning = "";
      record.screenshot = null;
      if (record.decision?.screenshot !== true) return request;
      if (owns()) setStatus(record, "Taking the screenshot…");
      try {
        const taken = await conceal(() => send("hd_anki_screenshot", { templateId: record.templateId }));
        if (typeof taken?.filename !== "string" || !taken.filename) throw new Error("no screenshot was taken");
        record.screenshot = { token: taken.token, filename: taken.filename };
        return { ...request, screenshot: record.screenshot };
      } catch (error) {
        record.screenshotWarning = `Screenshot: ${error.message}`;
        return { ...request, captureUnavailable: [...(request.captureUnavailable ?? []), "screenshot"] };
      }
    }
    function submitted(record, result) {
      if (result.state === "uncertain") { uncertain(record, result.error); return true; }
      if (result.state !== "added" && result.state !== "updated") return false;
      // A configuration epoch can change while Anki commits. The submitted
      // record still owns its outcome; never turn a known write into a retry.
      record.terminal = true;
      record.noteIds = [result.noteId];
      const label = result.state === "added" ? "Added" : "Updated";
      const warnings = [record.screenshotWarning, ...(result.warnings ?? [])].filter(Boolean);
      setMiningButtonState(record, "success", `Find ${label.toLowerCase()} note in Anki`);
      setStatus(record, `${label} note ${result.noteId}. ${warnings.join(" ")}`.trim(),
        warnings.length > 0 ? "warning" : "success");
      refreshAll(); // Best-effort checks cannot turn a confirmed write into a retry.
      return true;
    }
    async function prepareCapture(record, request, owns) {
      const selected = record.decision?.capture;
      if (!selected) return request;
      if (!request.capturePin?.token) throw new Error("The capture pin expired. Look up the text again.");
      if (!record.captureJobId) {
        const started = await capture("hd_capture_export", {
          token: request.capturePin.token,
          requirements: selected.requirements,
        });
        record.captureJobId = started.jobId;
      }
      for (;;) {
        const status = await capture("hd_capture_job_status", { jobId: record.captureJobId });
        if (status.state === "ready") {
          return readyCaptureRequest(record, request, selected.requirements, status.assets);
        }
        if (status.state === "error") {
          const message = status.error || "Captured media could not be encoded.";
          await cancelCapture(record);
          throw new Error(message);
        }
        if (owns()) captureProgress(record, status);
        await wait(100);
      }
    }
    async function submit(record, fromPointer) {
      if (!current(record) || record.add.disabled || record.busy || record.terminal) return;
      const group = record.group, epoch = group.epoch;
      const owns = () => current(record) && record.group === group && group.epoch === epoch;
      const baseRequest = (fromPointer && record.pointerRequest) || payload(record);
      const request = record.decision?.clientSpeech
        ? { ...baseRequest, clientSpeech: record.decision.clientSpeech }
        : baseRequest;
      record.pointerRequest = null;
      record.busy = true;
      setMiningButtonState(record, "mining");
      disabled(record);
      setStatus(record, "Saving to Anki…");
      let writeSent = false;
      try {
        const prepared = await prepareCapture(record, await prepareScreenshot(record, request, owns), owns);
        if (owns()) setStatus(record, "Saving to Anki…");
        writeSent = true;
        const result = await send("hd_anki_submit", { request: prepared });
        // These replies confirm that no note was written. Release the export
        // even if its popup retired while Anki was checking the submission.
        if (["duplicate", "invalid"].includes(result.state)) await cancelCapture(record);
        if (!submitted(record, result) && owns()) { decision(record, { ...result, canAdd: false }); refreshAll(); }
      } catch (error) {
        await handleSubmissionFailure(record, error, writeSent, owns);
      } finally {
        record.busy = false;
        if (current(record)) { disabled(record); onChange(record.group.owner); refresh(record.group); }
      }
    }
    // An unconfirmed write has no note ID, so Anki searches for the expression.
    async function browse(record) {
      if (!current(record) || record.add.disabled) return;
      record.add.disabled = true;
      const noteIds = record.terminal ? record.noteIds : record.decision?.noteIds;
      try {
        const result = await send("hd_anki_browse", { request: {
          noteIds: Array.isArray(noteIds) ? noteIds : [],
          expression: record.result.term.expression,
          configKey: record.configKey,
          templateId: record.templateId,
        } });
        if (current(record) && Array.isArray(result?.noteIds)) {
          if (record.terminal) record.noteIds = result.noteIds;
          else if (record.decision) record.decision = { ...record.decision, noteIds: result.noteIds };
        }
        if (current(record) && result?.opened === false) {
          record.terminal = false;
          record.noteIds = [];
          record.decision = null;
          record.viewChecked = false;
          record.needsCheck = true;
          setMiningButtonState(record, "checking");
          setStatus(record, "");
          refresh(record.group);
        }
      }
      catch (error) { if (current(record)) setStatus(record, `Could not open Anki: ${error.message}`, "error"); }
      finally {
        if (current(record)) { disabled(record); onChange(record.group.owner); }
      }
    }
    function controls(record) {
      if (record.control) return;
      const document = record.actions.ownerDocument;
      const feedback = record.feedback || document.createElement("div");
      if (!record.feedback) {
        feedback.className = "gsm-hoshidicts-mining-feedback";
        feedback.setAttribute("role", "status");
        feedback.setAttribute("aria-live", "polite");
        feedback.hidden = true;
        record.actions.after(feedback);
      }
      const control = document.createElement("div");
      control.className = "gsm-hoshidicts-anki-control";
      const add = record.add || document.createElement("button");
      if (!record.custom) {
        add.type = "button";
        add.className = "gsm-hoshidicts-mine-button";
      }
      const badge = document.createElement("span");
      badge.className = "gsm-hoshidicts-capture-badge";
      badge.hidden = true;
      const output = document.createElement("output");
      output.className = "gsm-hoshidicts-anki-status";
      output.setAttribute("aria-live", "polite");
      control.append(badge, output);
      control.hidden = true;
      feedback.append(control);
      if (!record.custom) {
        const leadingAction = record.actions.firstElementChild;
        if (leadingAction?.matches(".gsm-hoshidicts-popup-close, .gsm-hoshidicts-kanji-back")) {
          leadingAction.after(add);
        } else {
          record.actions.prepend(add);
        }
      }
      Object.assign(record, { feedback, control, add, badge, output, hidden: false });
      setMiningButtonState(record, "checking");
      record.onMouseDown = event => {
        if (event.button === 0 && current(record) && !views(record)) record.pointerRequest = payload(record);
      };
      record.onClick = event => {
        if (views(record)) void browse(record);
        else void submit(record, event.detail > 0);
      };
      add.addEventListener("mousedown", record.onMouseDown);
      add.addEventListener("click", record.onClick);
      disabled(record);
    }
    function recordSpecs(group) {
      const specs = [];
      for (const item of group.items) {
        specs.push({
          item,
          binding: item.actions,
          custom: false,
          templateId: primaryTemplateId,
          label: "Anki",
        });
        for (const add of item.actions.querySelectorAll(".gsm-hoshidicts-custom-anki-button")) {
          const descriptor = customButtonTemplates.get(add.dataset.customButtonId);
          if (!descriptor) continue;
          specs.push({
            item,
            binding: add,
            add,
            custom: true,
            templateId: descriptor.templateId,
            label: descriptor.label,
          });
        }
      }
      return specs;
    }
    function recordForSpec(group, spec) {
      let record = bound.get(spec.binding);
      if (reusableRecord(record, group, spec)) {
        updateRecord(record, spec);
        return record;
      }
      if (record) {
        removeControls(record);
        bound.delete(spec.binding);
      }
      record = createRecord(group, spec);
      bound.set(spec.binding, record);
      return record;
    }
    function reconcile(group) {
      const next = recordSpecs(group).map(spec => recordForSpec(group, spec));
      const retained = new Set(next);
      const retainedBindings = new Set(next.map(record => record.binding));
      for (const record of group.records) {
        if (retained.has(record) || retainedBindings.has(record.binding)) continue;
        removeControls(record);
        if (bound.get(record.binding) === record) bound.delete(record.binding);
      }
      group.records = next;
    }
    function bind(items, context) {
      let group = owners.get(context.owner);
      if (group && group.request !== context.request) { retire(context.owner); group = null; }
      if (!group) {
        group = { ...context, items, records: [], epoch: 0, queued: false };
        owners.set(context.owner, group);
      }
      else Object.assign(group, context);
      group.items = items;
      reconcile(group);
      group.records.forEach(disabled);
      refresh(group);
    }
    function retire(owner) {
      for (const [key, group] of owners) {
        if (owner !== undefined && owner !== key) continue;
        owners.delete(key);
        for (const record of group.records) if (record.control) showControls(record, false);
      }
    }
    return { bind, retire,
      refresh(owner) { const group = owners.get(owner); if (group) refresh(group, true); },
      update(options, ready = true) {
        const anki = globalThis.HDReaderOptions.normaliseAnki(options.anki);
        const customButtons = globalThis.HDReaderOptions.normaliseCustomButtons(options.customButtons);
        const key = JSON.stringify([ready, anki, customButtons, options.audioSources, options.mediaCapture]);
        if (key === settingsKey) return;
        settingsKey = key;
        primaryTemplateId = anki.templates[0].id;
        templateIds = new Set(anki.templates.map(template => template.id));
        customButtonTemplates = new Map(customButtons.filter(button => button.type === "anki")
          .map(button => [button.id, { templateId: button.templateId, label: button.label }]));
        enabled = ready && (anki.templates.some(template => Boolean(template.model))
          || customButtonTemplates.size > 0);
        for (const group of owners.values()) {
          group.epoch++;
          reconcile(group);
          for (const record of group.records) if (record.control) showControls(record, false);
          refresh(group, true);
        }
      },
    };
  }
  globalThis.HDAnki = { createAnkiController };
}());
