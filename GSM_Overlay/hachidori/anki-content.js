// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };

  const FEEDBACK_PRIORITY = { info: 0, success: 1, warning: 2, error: 3 };
  // Why a Netflix, YouTube or Crunchyroll note has no sentence audio or GIF, by
  // the reason the reader, the page or the worker reported. Tab capture and the
  // line audio report these the same way on every site.
  const RECORDING_UNAVAILABLE = {
    grant: "Chrome has not let Hachidori record this tab yet. Click Hachidori's toolbar button once on this tab, or add notes with the “Add the current popup entry to Anki” shortcut from chrome://extensions/shortcuts; later notes in this tab will record the line.",
    "no-gif": "no GIF could be made of the line.",
    unheard: "the line did not play through, so its audio was not recorded.",
    unsupported: "this browser does not let extensions record a tab.",
  };
  const NETFLIX_UNAVAILABLE = {
    "no-timeline": "Netflix's subtitle timing for this episode was not found. Reload the Netflix page; Netflix may also have changed its data.",
    image: "this episode's Japanese subtitles are images, which have no timed text.",
    none: "this episode has no Japanese subtitle track.",
    failed: "Netflix's subtitle file for this episode could not be read.",
    "no-match": "the hovered subtitle matched no line in Netflix's subtitle file.",
    ambiguous: "the hovered subtitle matched more than one line in Netflix's subtitle file.",
    silent: "the recording was silent, so no audio was attached. If the video is not muted, Netflix may be blocking capture of protected playback; turning off Chrome's “Use graphics acceleration when available” can help.",
    player: "Netflix's player controls were not found, so the line could not be replayed.",
    replay: "Netflix did not finish replaying the line.",
    linked: "this browser is linked to another Hachidori, so Netflix lines are not recorded.",
    ...RECORDING_UNAVAILABLE,
  };
  const YOUTUBE_UNAVAILABLE = {
    "no-timeline": "YouTube's caption timing for this video was not found. Reload the YouTube page; YouTube may also have changed its data.",
    live: "live streams are not supported.",
    failed: "YouTube's caption file for this video could not be read.",
    "no-match": "the hovered caption matched no line in YouTube's caption file.",
    ambiguous: "the hovered caption matched more than one line in YouTube's caption file.",
    silent: "the recording was silent, so no audio was attached. Check that the video is not muted.",
    player: "YouTube's player was not found, so the line could not be replayed.",
    replay: "YouTube did not finish replaying the line.",
    ad: "an ad was playing, so the line could not be replayed.",
    linked: "this browser is linked to another Hachidori, so YouTube lines are not recorded.",
    ...RECORDING_UNAVAILABLE,
  };
  // Crunchyroll's subtitles come from a user script, such as the Script
  // Store's Jimaku Player (crunchyroll-content.js).
  const CRUNCHYROLL_UNAVAILABLE = {
    "no-timeline": "no subtitle timing was found for this episode. Load its Japanese subtitles with Jimaku Player from the Script Store; a Crunchyroll page that was open before Crunchyroll mining went on needs a reload.",
    failed: "the subtitle file for this episode could not be read.",
    "no-match": "the hovered subtitle matched no line in the episode's subtitle file.",
    ambiguous: "the hovered subtitle matched more than one line in the episode's subtitle file.",
    silent: "the recording was silent, so no audio was attached. If the video is not muted, Crunchyroll may be blocking capture of protected playback; turning off Chrome's “Use graphics acceleration when available” can help.",
    player: "Crunchyroll's video was not found, so the line could not be replayed.",
    replay: "Crunchyroll did not finish replaying the line.",
    linked: "this browser is linked to another Hachidori, so Crunchyroll lines are not recorded.",
    ...RECORDING_UNAVAILABLE,
  };
  // The sites whose subtitle lines a note can record: the mining request's
  // field, the controller option that records a line, the flag a linked
  // browser's worker adds to a preflight, and the warnings' label and reasons.
  // The first is also what a stale decision without the field reads as.
  const VIDEO_SITES = [
    { field: "netflix", recorder: "recordNetflixLine", linked: "netflixLinked", label: "Netflix mining",
      reasons: NETFLIX_UNAVAILABLE },
    { field: "youtube", recorder: "recordYouTubeLine", linked: "youtubeLinked", label: "YouTube mining",
      reasons: YOUTUBE_UNAVAILABLE },
    { field: "crunchyroll", recorder: "recordCrunchyrollLine", linked: "crunchyrollLinked", label: "Crunchyroll mining",
      reasons: CRUNCHYROLL_UNAVAILABLE },
  ];
  const siteReason = (site, reason) => Object.hasOwn(site.reasons, reason) ? site.reasons[reason] : reason;
  const heldMedia = media => media && typeof media.filename === "string" && media.filename
    ? { token: media.token, filename: media.filename } : null;
  // `wanted` is { audio, gif }, the media the note's fields map; a warning
  // names those it is about. `outcome` collects the warnings and the
  // captureUnavailable kinds while a recording is applied.
  function mediaLabel(wanted) {
    if (wanted.audio && wanted.gif) return "Sentence audio and GIF";
    return wanted.audio ? "Sentence audio" : "GIF";
  }
  function markUnavailable(site, outcome, wanted, reason) {
    outcome.warnings.push(`${mediaLabel(wanted)}: ${siteReason(site, reason)}`);
    if (wanted.audio) outcome.captureUnavailable.push("sentence-audio");
    if (wanted.gif) outcome.captureUnavailable.push("gif");
  }
  function applyRecordedMedia(site, record, outcome, wanted, recorded) {
    if (wanted.audio) {
      const audio = heldMedia(recorded?.audio);
      if (audio) record.sentenceAudio = audio;
      else markUnavailable(site, outcome, { audio: true }, typeof recorded?.audio?.unavailable === "string"
        ? recorded.audio.unavailable : "no audio was recorded.");
    }
    // The GIF is held under its own token, or {gif} falls back to the screenshot.
    if (wanted.gif) {
      const gif = heldMedia(recorded?.gif);
      if (gif) record.gif = gif;
      else markUnavailable(site, outcome, { gif: true }, typeof recorded?.gif?.unavailable === "string"
        ? recorded.gif.unavailable : "no-gif");
    }
  }
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
    record.control.hidden = record.hidden || record.output.textContent === "";
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
      checking: "Checking Anki card status — click to add anyway",
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
      || (!record.terminal && !record.opensSettings && record.add.dataset.state !== "checking"
        && (record.needsCheck || (!record.decision?.canAdd && !views(record))));
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
  function decision(record, value) {
    record.decision = value;
    if (!record.terminal && !record.busy) {
      const state = decisionState(value);
      setMiningButtonState(record, state, state === "view-existing" ? "" : value.error || "");
      setStatus(record, value.error || "", value.error ? "error" : "info");
    }
    disabled(record);
  }
  function uncertain(record, error) {
    record.terminal = true;
    setMiningButtonState(record, "error", "Check Anki before trying again");
    setStatus(record, error, "error");
  }
  function restartChecks(records) {
    for (const record of records) {
      if (record.terminal) continue;
      record.viewChecked = false;
      record.needsCheck = true;
      record.decision = null;
      record.opensSettings = false;
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
  // The action disables itself while it works, and Chrome then moves focus
  // out of the popup. Pressed from the keyboard, it gets focus back once it
  // is enabled again, unless the reader has focused something else since.
  // A mouse press takes none back.
  function keyboardFocusReturn(control) {
    if (!control.matches(":focus-visible")) return () => {};
    return () => {
      const document = control.ownerDocument;
      const unfocused = (control.getRootNode().activeElement ?? document.body) === document.body
        && document.activeElement === document.body;
      if (unfocused && control.isConnected && !control.disabled) control.focus({ preventScroll: true });
    };
  }
  // The button of a Template without a deck says so and opens Settings; a
  // custom button's Template that is unavailable says so in its status.
  function showUnavailable(record, value, error) {
    if (record.opensSettings && !record.custom) {
      record.needsCheck = false;
      setMiningButtonState(record, "unavailable", error);
    }
    if (!value && record.custom) {
      record.needsCheck = false;
      setMiningButtonState(record, "unavailable", error || "This Anki Template is unavailable.");
      setStatus(record, error || "This Anki Template is unavailable.", "error");
    }
  }

  function createAnkiController({
    send,
    onChange,
    // The page's own overlays are hidden for a viewport screenshot and restored
    // afterwards; without a host to hide, the screenshot is just taken.
    conceal = during => during(),
    // Experimental Netflix mining: records a cue's line through the page and
    // resolves with { audio, gif } for the fields, or with why there is none
    // (netflix-content.js). Its options { audio, gif } name the media wanted;
    // `conceal` is passed on for the tab capture a GIF needs.
    recordNetflixLine = async () => { throw new Error("this page cannot replay Netflix lines."); },
    // YouTube mining: the same for a YouTube caption's cue, which
    // the same reader records (netflix-content.js).
    recordYouTubeLine = async () => { throw new Error("this page cannot replay YouTube lines."); },
    // Experimental Crunchyroll mining: the same for a Crunchyroll subtitle's cue.
    recordCrunchyrollLine = async () => { throw new Error("this page cannot replay Crunchyroll lines."); },
    // Experimental Netflix mining: takes a Netflix subtitle note's screenshot
    // through `capture(crop)` with what Netflix draws over its video hidden,
    // `crop` being where the video's picture is (netflix-content.js).
    videoScreenshot = capture => capture(null),
    // Opens Settings → Anki for the profile the popup's controls act in, or
    // null where the page cannot open Settings.
    openSettings = null,
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
    // `emptyDeck`: the Template's only problem is that it names no deck. Its
    // button then says so and opens Settings → Anki (docs/languages.md 6.3).
    function available(records, value, error = "", emptyDeck = false) {
      for (const record of records) {
        record.opensSettings = !value && emptyDeck && typeof openSettings === "function"
          && !record.terminal && !cachedView(record.decision);
        const show = value || record.custom || record.terminal || cachedView(record.decision) || record.opensSettings;
        if (show && record.actions.isConnected) controls(record);
        if (record.control) showControls(record, show);
        if (!value && !show) record.needsCheck = false;
        showUnavailable(record, value, error);
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
      if (!cachedView(result) || record.busy || record.terminal) return;
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
    // One request for every record of this Template that still needs its
    // readiness, so the worker shares one duplicate lookup and one Anki add
    // check between them. A reply applies only to a record still bound here.
    async function checkRecords(records, owns) {
      const pending = records.filter(needsCheck);
      if (!owns() || !pending.length) return;
      for (const record of pending) record.needsCheck = false;
      let replies;
      try {
        ({ replies } = await send("hd_anki_preflight_batch", { requests: pending.map(payload) }));
      } catch (error) {
        replies = pending.map(() => ({ state: "error", canAdd: false, error: error.message }));
      }
      pending.forEach((record, index) => {
        if (owns() && boundHere(record) && !record.busy && !record.terminal) decision(record, replies[index]);
      });
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
      available(records, status.available, status.error, status.emptyDeck === true);
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
          record.opensSettings = false;
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
    // The worker holds a recorded line like a picture, and releases it the same way.
    async function discardSentenceAudio(record) {
      if (!record.sentenceAudio) return;
      const { token } = record.sentenceAudio;
      record.sentenceAudio = null;
      try { await send("hd_anki_screenshot_discard", { request: { token } }); } catch { /* A restarted worker holds nothing. */ }
    }
    // The recorded GIF is held and released exactly like the line's audio.
    async function discardGif(record) {
      if (!record.gif) return;
      const { token } = record.gif;
      record.gif = null;
      try { await send("hd_anki_screenshot_discard", { request: { token } }); } catch { /* A restarted worker holds nothing. */ }
    }
    // The media this submission captured is nobody's once no note was written.
    async function discardCaptures(record) {
      await discardScreenshot(record);
      await discardSentenceAudio(record);
      await discardGif(record);
    }
    async function handleSubmissionFailure(record, error, writeSent, owns) {
      if (!writeSent) {
        // Nothing was sent, so the media this submission took is nobody's.
        await discardCaptures(record);
      } else if (!error.responseReceived) {
        uncertain(record, `The write could not be confirmed. Check Anki before trying again. ${error.message}`);
        return;
      } else {
        // A worker reply confirms that no Anki mutation was sent. Release the
        // request-owned export even after its popup owner has retired.
        await discardCaptures(record);
      }
      if (!owns()) return;
      setMiningButtonState(record, decisionState(record.decision ?? { state: "error" }));
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
        // A note from a YouTube caption asks for the video's frame (YouTube
        // mining), and one from a Netflix subtitle for the video's picture
        // alone, or Netflix's preview where it comes out black (Netflix mining).
        const capture = crop => conceal(() => send("hd_anki_screenshot", { templateId: record.templateId,
          ...(request.youtube ? { videoFrame: true } : {}), ...(crop ? { crop } : {}) }));
        const taken = await (request.netflix ? videoScreenshot(capture) : capture(null));
        if (typeof taken?.filename !== "string" || !taken.filename) throw new Error("no screenshot was taken");
        record.screenshot = { token: taken.token, filename: taken.filename };
        return { ...request, screenshot: record.screenshot };
      } catch (error) {
        record.screenshotWarning = `Screenshot: ${error.message}`;
        return { ...request, captureUnavailable: [...(request.captureUnavailable ?? []), "screenshot"] };
      }
    }
    const recorders = { recordNetflixLine, recordYouTubeLine, recordCrunchyrollLine };
    // Netflix and YouTube mining: the hovered subtitle line's
    // audio and, when a {gif} field needs it, a looping GIF. The page records
    // the line, with the reader concealed while it captures the tab. Like the
    // screenshot, media that cannot be recorded is a warning on an otherwise
    // ordinary note; {gif} falls back to the screenshot the submission already took.
    //
    // `wanted` is { audio, gif }; `outcome` collects the warnings and the
    // captureUnavailable kinds while each recorded item is applied to `record`.
    async function recordVideoMedia(site, record, outcome, wanted, cue) {
      try {
        const recorded = await recorders[site.recorder](cue, record.templateId, { ...wanted, conceal });
        if (typeof recorded?.unavailable === "string") markUnavailable(site, outcome, wanted, recorded.unavailable);
        else applyRecordedMedia(site, record, outcome, wanted, recorded);
      } catch (error) {
        markUnavailable(site, outcome, wanted, error.message);
      }
    }
    async function prepareVideoMedia(record, request, owns) {
      record.videoWarning = "";
      record.sentenceAudio = null;
      record.gif = null;
      // A linked browser records nothing. Its host never sees the cue, so its
      // preflight cannot say which media the fields map; the reader warns for
      // any linked video-site note, and {gif} keeps its screenshot.
      const linked = VIDEO_SITES.find(entry => record.decision?.[entry.linked] === true);
      if (linked !== undefined) {
        record.videoWarning = `${linked.label}: ${linked.reasons.linked}`;
        return request;
      }
      const wanted = { audio: record.decision?.sentenceAudio === true, gif: record.decision?.gif === true };
      if (!wanted.audio && !wanted.gif) return request;
      const site = VIDEO_SITES.find(entry => request[entry.field] !== null && typeof request[entry.field] === "object")
        ?? VIDEO_SITES[0];
      const outcome = { warnings: [], captureUnavailable: [...(request.captureUnavailable ?? [])] };
      const cue = request[site.field]?.cue;
      if (!cue) {
        markUnavailable(site, outcome, wanted, request[site.field]?.unavailable ?? "no-timeline");
      } else {
        if (owns()) setStatus(record, "Recording the line…");
        await recordVideoMedia(site, record, outcome, wanted, cue);
      }
      record.videoWarning = outcome.warnings.join(" ");
      const next = { ...request };
      if (record.sentenceAudio) next.sentenceAudio = record.sentenceAudio;
      if (record.gif) next.gif = record.gif;
      if (outcome.captureUnavailable.length) next.captureUnavailable = outcome.captureUnavailable;
      return next;
    }
    function submitted(record, result) {
      if (result.state === "uncertain") { uncertain(record, result.error); return true; }
      if (result.state !== "added" && result.state !== "updated") return false;
      // A configuration epoch can change while Anki commits. The submitted
      // record still owns its outcome; never turn a known write into a retry.
      record.terminal = true;
      record.noteIds = [result.noteId];
      const label = result.state === "added" ? "Added" : "Updated";
      const warnings = [record.screenshotWarning, record.videoWarning, ...(result.warnings ?? [])].filter(Boolean);
      setMiningButtonState(record, "success", `Find ${label.toLowerCase()} note in Anki`);
      setStatus(record, `${label} note ${result.noteId}. ${warnings.join(" ")}`.trim(),
        warnings.length > 0 ? "warning" : "success");
      refreshAll(); // Best-effort checks cannot turn a confirmed write into a retry.
      return true;
    }
    // Add anyway: this note's media requirements without waiting for its
    // duplicate lookup. The override belongs only to this submission; any
    // other request is returned unchanged. Returns null once the popup no
    // longer owns the record.
    async function addAnywayRequest(record, request, owns) {
      if (request.allowDuplicate !== true) return request;
      let checkedRequest = request;
      if (checkedRequest.configKey === null) {
        const status = await send("hd_anki_status", { templateId: record.templateId });
        if (!status.available) throw new Error(status.error || "Anki mining is unavailable.");
        checkedRequest = { ...checkedRequest, configKey: status.configKey };
      }
      const checked = await send("hd_anki_preflight", { request: checkedRequest });
      if (!owns()) return null;
      record.decision = checked;
      if (!checked.canAdd) throw new Error(checked.error || "Anki rejected this note.");
      return checked.clientSpeech ? { ...checkedRequest, clientSpeech: checked.clientSpeech } : checkedRequest;
    }
    async function submit(record, fromPointer) {
      if (!current(record) || record.add.disabled || record.busy || record.terminal) return;
      const group = record.group, epoch = group.epoch;
      const owns = () => current(record) && record.group === group && group.epoch === epoch;
      const baseRequest = (fromPointer && record.pointerRequest) || payload(record);
      let request = record.decision?.clientSpeech
        ? { ...baseRequest, clientSpeech: record.decision.clientSpeech }
        : baseRequest;
      if (record.add.dataset.state === "checking") request = { ...request, allowDuplicate: true };
      const returnFocus = keyboardFocusReturn(record.add);
      record.pointerRequest = null;
      record.busy = true;
      record.needsCheck = false;
      setMiningButtonState(record, "mining");
      disabled(record);
      setStatus(record, "Saving to Anki…");
      let writeSent = false;
      try {
        request = await addAnywayRequest(record, request, owns);
        if (request === null) return;
        const screenshotted = await prepareScreenshot(record, request, owns);
        const prepared = await prepareVideoMedia(record, screenshotted, owns);
        if (owns()) setStatus(record, "Saving to Anki…");
        writeSent = true;
        const result = await send("hd_anki_submit", { request: prepared });
        // These replies confirm that no note was written. Release the export
        // even if its popup retired while Anki was checking the submission.
        if (["duplicate", "invalid"].includes(result.state)) await discardCaptures(record);
        if (!submitted(record, result) && owns()) { decision(record, { ...result, canAdd: false }); refreshAll(); }
      } catch (error) {
        await handleSubmissionFailure(record, error, writeSent, owns);
      } finally {
        record.busy = false;
        if (current(record)) { disabled(record); onChange(record.group.owner); refresh(record.group); returnFocus(); }
      }
    }
    // An unconfirmed write has no note ID, so Anki searches for the expression.
    async function browse(record) {
      if (!current(record) || record.add.disabled) return;
      const returnFocus = keyboardFocusReturn(record.add);
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
        if (current(record)) { disabled(record); onChange(record.group.owner); returnFocus(); }
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
      const output = document.createElement("output");
      output.className = "gsm-hoshidicts-anki-status";
      output.setAttribute("aria-live", "polite");
      control.append(output);
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
      Object.assign(record, { feedback, control, add, output, hidden: false });
      setMiningButtonState(record, "checking");
      record.onMouseDown = event => {
        if (event.button === 0 && current(record) && !views(record) && !record.opensSettings) {
          record.pointerRequest = payload(record);
          if (add.dataset.state === "checking") record.pointerRequest.allowDuplicate = true;
        }
      };
      record.onClick = event => {
        if (record.opensSettings) {
          if (current(record)) openSettings();
        } else if (views(record) && !(event.detail > 0 && record.pointerRequest?.allowDuplicate === true)) void browse(record);
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
        // A renderer that shows one entry's actions in a shared toolbar names
        // the entry its custom buttons mine; otherwise they are in its row.
        const customActions = "customActions" in item ? item.customActions : item.actions;
        for (const add of customActions?.querySelectorAll(".gsm-hoshidicts-custom-anki-button") ?? []) {
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
        const key = JSON.stringify([ready, anki, customButtons, options.audioSources]);
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
  // Mining screenshots address this exact document before and after capture.
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (message?.target === "hachidori-anki-content" && message.type === "hd_anki_document") sendResponse({ present: true });
  });
  globalThis.HDAnki = { createAnkiController };
}());
