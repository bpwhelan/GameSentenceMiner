// Central content for the overlay-settings discoverability layer.
//
// Three globals consumed by settings-enhancer.js:
//   GSM_SETTING_DESCRIPTIONS  id -> one-line description, injected under settings
//                             that don't already have a hand-written .hotkey-info.
//   GSM_GROUP_KEYWORDS        group-heading substring -> extra search synonyms, so a
//                             search like "controller" finds the Gamepad settings.
//   GSM_CAPABILITY_CARDS      the "what can the overlay do" cards on the Overview tab;
//                             each jumps to the tab named by `tab`.
//
// Descriptions are keyed by the control's element id (which equals its setting key).
(function (global) {
  "use strict";

  // Only ids that lack an inline .hotkey-info need an entry here; the enhancer
  // skips any control that already has help text so nothing is duplicated.
  const GSM_SETTING_DESCRIPTIONS = {
    // Visibility / capture indicators
    showReadyIndicator: "Show a small dot when the overlay is connected and ready to capture.",
    showTextIndicators: "The red boxes/borders drawn around captured text — they show the overlay is working. Turn this off to remove the boxes.",
    fadeTextIndicators: "Fade the capture borders out after a moment instead of keeping them solid.",
    showRecycledIndicator: "Mark lines the overlay has already shown before (recycled text).",

    // Behavior / startup
    openSettingsOnStartup: "Open this settings window automatically each time the overlay starts.",
    showMainBoxOnStartup: "Show the floating debug box on startup. Not recommended — use the tray instead.",
    afkTimer: "Auto-minimize the overlay after this many idle minutes (0 disables).",

    // OCR / capture
    engine_v2: "Which OCR engine reads text from the screen. Stored with your active GSM profile.",
    monitor_to_capture: "Which monitor the OCR engine captures from.",
    use_ocr_area_config_v2: "Restrict OCR to the capture areas you defined instead of the whole screen.",
    minimum_character_size: "Ignore detected characters smaller than this pixel height (0 = keep all).",
    periodic: "Re-run OCR on a timer so text updates without a manual trigger.",
    periodic_interval: "How often periodic scanning re-runs OCR, in seconds.",
    scan_on_mouse_move: "Only re-scan while the cursor is moving over the game window.",
    inject_scanned_lines: "Send scanned lines to the text log so they count toward mining and stats.",
    use_ocr_result_v2: "Use the newer OCR result pipeline.",
    supplement_ocr_result_with_overlay: "Merge overlay text into the OCR result for more complete lines.",
    use_text_filtering: "Filter out junk/noise characters from OCR output.",
    ocr_full_screen_instead_of_obs: "Capture the full screen for OCR instead of the OBS game window.",

    // Furigana / readings
    showFurigana: "Draw furigana/pinyin readings above the captured text.",
    hideFuriganaOnStartup: "Start with readings hidden; reveal them with the toggle hotkey.",
    hideFuriganaAfterSeconds: "Auto-hide readings this many seconds after they appear (0 = stay visible).",
    furiganaColor: "Color of the furigana reading text.",
    furiganaOutlineColor: "Color of the outline drawn around furigana for contrast.",
    furiganaOutlineWidth: "Thickness of the furigana outline, in pixels.",
    furiganaFontWeight: "How bold the furigana text is drawn.",

    // Pinyin tone colors
    pinyinTone1Color: "Color for first-tone (high level) pinyin syllables.",
    pinyinTone2Color: "Color for second-tone (rising) pinyin syllables.",
    pinyinTone3Color: "Color for third-tone (dipping) pinyin syllables.",
    pinyinTone4Color: "Color for fourth-tone (falling) pinyin syllables.",
    pinyinTone5Color: "Color for neutral-tone pinyin syllables.",

    // Live stats fields
    liveStatsFieldCharsPerHour: "Show your reading speed in characters per hour.",
    liveStatsFieldTotalCharacters: "Show total characters read this session.",
    liveStatsFieldActiveReadingTime: "Show time spent actively reading this session.",
    liveStatsFieldRawReadingTime: "Show raw elapsed session time, including idle gaps.",
    liveStatsFieldCardsMined: "Show how many Anki cards you've mined this session.",
  };

  // Matched case-insensitively against each group's heading (<h4>/<summary>) text.
  // Every label inside a matching group inherits these terms in the search index.
  const GSM_GROUP_KEYWORDS = {
    "visibility": "indicator border boxes box rectangle red remove hide ready recycled status outline",
    "live stats": "speed cph characters per hour reading time goals widget",
    "pomodoro": "timer focus break work countdown",
    "furigana": "reading ruby kana pronunciation rubytext",
    "pinyin": "chinese tone pronunciation mandarin",
    "ocr": "capture screen recognize text screenshot scan",
    "periodic scanning": "auto timer interval rescan",
    "jiten": "dictionary srs jpdb anki grade lookup",
    "overlay integration": "srs highlight jpdb grade dictionary",
    "gamepad": "controller xbox playstation joystick dpad hands-free navigation",
    "hotkeys": "shortcut keybind keyboard hotkey",
    "textfeed": "texthooker feed history lines re-read clipboard window",
    "translation": "translate ai deepl machine translation",
    "text offset": "position align nudge calibrate",
    "profiles": "per-game scene per profile",
    "behavior": "startup launch auto-minimize afk",
  };

  // Overview "what the overlay can do" cards. `tab` must match a data-settings-tab value.
  const GSM_CAPABILITY_CARDS = [
    { icon: "📖", title: "Readings & Furigana", tab: "reading", blurb: "Furigana / pinyin readings above the text, plus styling, fonts, and reading language." },
    { icon: "✋", title: "Push to Show", tab: "interaction", blurb: "Hold or toggle a hotkey to reveal the overlay only when you want it — great for cutscenes and mouse-hiding games." },
    { icon: "🎮", title: "Hands-Free Gamepad Nav", tab: "gamepad", blurb: "Drive the cursor and trigger Yomitan lookups with a controller — no keyboard or mouse needed." },
    { icon: "📊", title: "Live Stats & Goals", tab: "stats", blurb: "Show chars/hour, cards mined, and your daily goals in-game, with a built-in Pomodoro timer." },
    { icon: "📚", title: "Jiten Reader", tab: "dictionary", blurb: "Jiten Reader Integration: SRS-aware highlighting and grading right from the overlay." },
    { icon: "🔍", title: "OCR Capture", tab: "capture", blurb: "Pick the engine, monitor, and capture area, and scan text on a timer or on demand." },
    { icon: "🗂️", title: "Per-Game Profiles", tab: "profiles", blurb: "Tie overlay settings to your GSM profiles to tie configuration to a set of games." },
    { icon: "⌨️", title: "Hotkeys & Interaction", tab: "interaction", blurb: "Customize every hotkey, Yomitan focus behavior, translation, and the TextFeed window." },
  ];

  global.GSM_SETTING_DESCRIPTIONS = GSM_SETTING_DESCRIPTIONS;
  global.GSM_GROUP_KEYWORDS = GSM_GROUP_KEYWORDS;
  global.GSM_CAPABILITY_CARDS = GSM_CAPABILITY_CARDS;
})(typeof window !== "undefined" ? window : globalThis);
