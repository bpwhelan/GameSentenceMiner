// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const extensionAsset = path => globalThis.chrome?.runtime?.getURL?.(path) || path;
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
    const title = message || {
      checking: "Checking Anki availability",
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
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.action = views(record) ? "view" : "add";
    const iconName = {
      ready: "big-circle",
      "add-duplicate": "add-duplicate-big-circle",
      overwrite: "overwrite-big-circle",
      "view-existing": "view-note",
    }[state];
    const icon = button.ownerDocument.createElement(iconName ? "img" : "span");
    icon.className = "gsm-hoshidicts-mine-icon";
    icon.setAttribute("aria-hidden", "true");
    if (iconName) {
      icon.dataset.icon = iconName;
      icon.src = extensionAsset(`render/icons/${iconName}.svg`);
      icon.alt = "";
      icon.draggable = false;
    }
    else icon.textContent = {
      checking: "…",
      mining: "⟳",
      success: "✓",
      error: "!",
      unavailable: "-",
    }[state] || "-";
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
      || (!record.terminal && (record.group.checking || (!record.decision?.canAdd && !views(record))));
  }
  function payload(record) {
    return { ...record.group.getRequest(record.result), configKey: record.group.configKey };
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
    record?.add?.remove();
    record?.control?.remove();
    if (record?.feedback) syncFeedbackSurface(record.feedback);
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
    const live = group => enabled && owners.get(group.owner) === group && !group.popup.hidden && group.isCurrent();
    const boundHere = record => bound.get(record.actions) === record && record.actions.isConnected;
    const current = record => live(record.group) && boundHere(record);
    const needsCheck = record => boundHere(record) && record.needsCheck && !record.busy && !record.terminal;
    function available(group, value) {
      for (const record of group.records) {
        if (value && record.actions.isConnected) controls(record);
        if (record.control) showControls(record, value);
        if (!value) record.needsCheck = false;
      }
    }
    async function checkRecords(group, owns) {
      for (const record of group.records) {
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
    async function checkGroup(group) {
      const epoch = group.epoch;
      const owns = () => live(group) && epoch === group.epoch;
      try {
        if (!owns()) return;
        const status = await send("hd_anki_status", {});
        if (!owns()) return;
        group.configKey = status.configKey;
        available(group, status.available);
        if (!status.available) return;
        onChange(group.owner);
        await checkRecords(group, owns);
      } catch {
        if (owns()) available(group, false);
      } finally {
        group.queued = group.checking = false;
        if (live(group)) {
          group.records.forEach(disabled);
          onChange(group.owner);
          refresh(group);
        }
      }
    }
    function refresh(group, all = false) {
      if (all) for (const record of group.records) record.needsCheck = !record.terminal;
      if (!live(group) || group.queued || !group.records.some(needsCheck)) return;
      group.queued = group.checking = true;
      group.records.forEach(record => {
        if (needsCheck(record) && record.add) setMiningButtonState(record, "checking");
        disabled(record);
      });
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
    // One viewport screenshot for this submission, taken with Hachidori's own
    // overlays hidden. A capture or upload that fails is a warning carried with
    // the note's outcome: the field renders empty and the note still goes in.
    async function prepareScreenshot(record, request, owns) {
      record.screenshotWarning = "";
      record.screenshot = null;
      if (record.decision?.screenshot !== true) return request;
      if (owns()) setStatus(record, "Taking the screenshot…");
      try {
        const taken = await conceal(() => send("hd_anki_screenshot", {}));
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
      setMiningButtonState(record, "success", `${label} note. Open it in Anki`);
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
        // Nothing was sent, so the picture this submission took is nobody's.
        if (!writeSent) await discardScreenshot(record);
        if (writeSent && !error.responseReceived) uncertain(record, `The write could not be confirmed. Check Anki before trying again. ${error.message}`);
        else if (owns()) {
          setMiningButtonState(record, decisionState(record.decision));
          setStatus(record, `Could not add: ${error.message}`, "error");
        }
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
        await send("hd_anki_browse", { request: {
          noteIds: Array.isArray(noteIds) ? noteIds : [],
          expression: record.result.term.expression,
          configKey: record.group.configKey,
        } });
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
      const add = document.createElement("button");
      add.type = "button";
      add.className = "gsm-hoshidicts-mine-button";
      const badge = document.createElement("span");
      badge.className = "gsm-hoshidicts-capture-badge";
      badge.hidden = true;
      const output = document.createElement("output");
      output.className = "gsm-hoshidicts-anki-status";
      output.setAttribute("aria-live", "polite");
      control.append(badge, output);
      control.hidden = true;
      feedback.append(control);
      record.actions.prepend(add);
      Object.assign(record, { feedback, control, add, badge, output, hidden: false });
      setMiningButtonState(record, "checking");
      add.addEventListener("mousedown", event => {
        if (event.button === 0 && current(record) && !views(record)) record.pointerRequest = payload(record);
      });
      add.addEventListener("click", event => {
        if (views(record)) void browse(record);
        else void submit(record, event.detail > 0);
      });
      disabled(record);
    }
    function bind(items, context) {
      let group = owners.get(context.owner);
      if (group && group.request !== context.request) { retire(context.owner); group = null; }
      if (!group) { group = { ...context, records: [], epoch: 0, checking: false, queued: false }; owners.set(context.owner, group); }
      else Object.assign(group, context);
      const records = [...group.records];
      for (const item of items) {
        let record = bound.get(item.actions);
        if (record?.group === group && record.result === item.result) continue;
        removeControls(record);
        record = { ...item, group, busy: false, terminal: false, decision: null, needsCheck: true,
          captureJobId: null };
        bound.set(item.actions, record);
        records.push(record);
        disabled(record);
      }
      group.records = records.filter(boundHere);
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
        const key = JSON.stringify([ready, options.anki, options.audioSources, options.mediaCapture]);
        if (key === settingsKey) return;
        settingsKey = key;
        enabled = ready && Boolean(options.anki.model);
        for (const group of owners.values()) {
          group.epoch++;
          for (const record of group.records) if (record.control) showControls(record, false);
          refresh(group, true);
        }
      },
    };
  }
  globalThis.HDAnki = { createAnkiController };
}());
