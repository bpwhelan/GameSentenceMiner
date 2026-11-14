export type ChannelMode = "invoke" | "send" | "on";

const invokeExactChannels = new Set<string>([
  "show-error-box",
  "show-message-box",
  "open-external",
  "get-platform",
  "install-session.getActive",
  "install-session.retry",
  "changelog.getPendingDesktopUpdate",
  "changelog.markDesktopUpdateSeen",
  "changelog.clearManualDisplay",
  "changelog.applySettingChoice",
  "openOBS",
  "open-external-link",
  "openTexthooker",
  "runOverlay",
  "setOverlayEnabled",
  "getOverlayStatus",
  "run-furigana-window",
  "get_gsm_status",
  "ocr-replacements.load",
  "ocr-replacements.save"
]);

const sendExactChannels = new Set<string>([
  "tab-changed",
  "terminal-data",
  "hide",
  "show",
  "release-mouse",
  "open-settings",
  "open-yomitan-settings",
  "reply-current-settings",
  "close-furigana-window",
  "app-close",
  "app-minimize"
]);

const onExactChannels = new Set<string>([
  "obs.runtime.progress",
  "settings.seasonalEffectsChanged",
  "settings.visibleTabsChanged",
  "installing",
  "install-session.snapshot",
  "install-session.finished",
  "changelog.snapshot",
  "changelog.manualSnapshot",
  "app.navigateToTab",
  "steamGamesUpdated",
  "state-cleared",
  "notification",
  "load-settings",
  "display-info",
  "afk-hide",
  "show-overlay-hotkey",
  "toggle-furigana-visibility",
  "force-visible",
  "toggle-main-box",
  "new-magpieCompatibility",
  "furigana-script-result",
  "set-furigana-character",
  "preload-settings"
]);

const invokePrefixes = [
  "capture.",
  "reader.",
  "game-launcher.",
  "game-privileges.",
  "game-background.",
  "docs.",
  "data.",
  "state.",
  "settings.",
  "ankiBeacon.",
  "python.",
  "logs.",
  "ocr.",
  "obs.",
  "steam.",
  "vn.",
  "yuzu.",
  "front.",
  "texthook.",
  "textprocess.",
  "speech-recognition.",
  "scene-switcher.",
  "wanakana-",
  "kuroshiro-"
];

const sendPrefixes = [
  "ocr.",
  "settings.",
  "websocket-",
  "yomitan-",
  "toggle-",
  "update-",
  "set-",
  "resize-",
  "open-",
  "setting-",
  "text-"
];

const onPrefixes = [
  "game-privileges.",
  "data.",
  "terminal-",
  "ocr-",
  "state-",
  "websocket-",
  "settings-",
  "gsm-",
  "textprocess-",
  "texthook.",
  "speech-recognition.",
  "scene-switcher."
];

function isValidChannelName(channel: string): boolean {
  return /^[a-zA-Z0-9._:-]+$/.test(channel);
}

export function isAllowedChannel(mode: ChannelMode, channel: string): boolean {
  if (!isValidChannelName(channel)) {
    return false;
  }

  if (mode === "invoke") {
    return (
      invokeExactChannels.has(channel) ||
      invokePrefixes.some((prefix) => channel.startsWith(prefix))
    );
  }

  if (mode === "send") {
    return (
      sendExactChannels.has(channel) ||
      sendPrefixes.some((prefix) => channel.startsWith(prefix))
    );
  }

  return (
    onExactChannels.has(channel) ||
    onPrefixes.some((prefix) => channel.startsWith(prefix))
  );
}

