// Central content for the overlay-settings discoverability layer.
//
// Two globals consumed by settings-enhancer.js:
//   GSM_SETTING_DESCRIPTIONS  id -> optional tooltip for settings whose titles
//                             need context and have no hand-written help.
//   GSM_GROUP_KEYWORDS        group-heading substring -> extra search synonyms, so a
//                             search like "controller" finds the Gamepad settings.
//
// Descriptions are keyed by the control's element id (which equals its setting key).
(function (global) {
  "use strict";

  // Keep only useful context. Straightforward titles do not need a second
  // explanation or a help icon; existing markup supplies the detailed help.
  const GSM_SETTING_DESCRIPTIONS = {
    // Visibility / capture indicators
    showReadyIndicator: "Show a small dot when the overlay is connected and ready to capture.",
    showTextIndicators:
      "The red boxes/borders drawn around captured text — they show the overlay is working. Turn this off to remove the boxes.",
    showTextHitboxes: "Show red outlines around individual text lookup areas for debugging. Some languages use word-sized areas.",
    showRecycledIndicator: "Mark lines the overlay has already shown before (recycled text).",

    // Behavior / startup
    showMainBoxOnStartup: "Show the floating debug box on startup. Not recommended — use the tray instead.",

    // OCR / capture
    use_overlay_area_config: "Restrict OCR to the capture areas you defined instead of the whole screen.",
    last_sent_ocr_presence_invalidate_lookups:
      "Remove stale OCR text targets so Yomitan and controller lookups cannot select text that is no longer visible.",
    use_text_filtering: "Filter out junk/noise characters from OCR output.",

    // Live stats fields
    liveStatsFieldActiveReadingTime: "Show time spent actively reading this session.",
    liveStatsFieldRawReadingTime: "Show raw elapsed session time, including idle gaps.",
  };

  // Matched case-insensitively against each group's heading (<h4>/<summary>) text.
  // Every label inside a matching group inherits these terms in the search index.
  const GSM_GROUP_KEYWORDS = {
    visibility: "indicator border boxes box rectangle red remove hide ready recycled status outline",
    "live stats": "speed cph characters per hour reading time goals widget",
    pomodoro: "timer focus break work countdown",
    furigana: "reading ruby kana pronunciation rubytext",
    pinyin: "chinese tone pronunciation mandarin",
    ocr: "capture screen recognize text screenshot scan",
    "periodic scanning": "auto timer interval rescan",
    jiten: "dictionary srs jpdb anki grade lookup",
    "overlay integration": "srs highlight jpdb grade dictionary",
    gamepad: "controller xbox playstation joystick dpad hands-free navigation",
    hotkeys: "shortcut keybind keyboard hotkey",
    textfeed: "texthooker feed history lines re-read clipboard window",
    "custom page": "vn-guide vnguide kanjieater walkthrough route guide website url browser shortcut",
    "vn guide": "vn-guide kanjieater catalogue catalog search github fork local folder directory walkthrough route choice choices save load step advance undo spoiler",
    translation: "translate ai deepl machine translation",
    "text offset": "position align nudge calibrate",
    profiles: "per-game scene per profile",
    behavior: "startup launch auto-minimize afk",
  };

  global.GSM_SETTING_DESCRIPTIONS = GSM_SETTING_DESCRIPTIONS;
  global.GSM_GROUP_KEYWORDS = GSM_GROUP_KEYWORDS;
})(typeof window !== "undefined" ? window : globalThis);
