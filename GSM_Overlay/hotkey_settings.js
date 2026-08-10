const MODIFIER_TOKENS = new Set(["ctrl", "cmd", "alt", "shift"]);
const SUPPORTED_KEY_TOKENS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  ...Array.from({ length: 24 }, (_value, index) => `f${index + 1}`),
  "space",
  "return",
  "escape",
  "backspace",
  "delete",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "-",
  "_",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "`",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
]);

function isSupportedHotkey(value) {
  if (typeof value !== "string") {
    return false;
  }

  const rawTokens = value.split("+");
  if (rawTokens.some((token) => !token.trim())) {
    return false;
  }

  const tokens = rawTokens
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }

  let keyCount = 0;
  for (const token of tokens) {
    if (MODIFIER_TOKENS.has(token)) {
      continue;
    }
    if (!SUPPORTED_KEY_TOKENS.has(token)) {
      return false;
    }
    keyCount += 1;
  }
  return keyCount <= 1;
}

function normalizeConfiguredHotkeyValues(settings, defaults, settingKeys) {
  if (!settings || typeof settings !== "object") {
    return [];
  }

  const changedKeys = [];
  for (const key of settingKeys) {
    const defaultValue = defaults && defaults[key];
    if (typeof defaultValue !== "string" || !defaultValue.trim()) {
      continue;
    }

    const value = settings[key];
    const normalizedValue = isSupportedHotkey(value) ? value.trim() : "";
    const nextValue = normalizedValue || defaultValue;
    if (value !== nextValue) {
      settings[key] = nextValue;
      changedKeys.push(key);
    }
  }

  return changedKeys;
}

function registerHotkeyWithFallback({ accelerator, fallbackAccelerator, register }) {
  let registered = false;
  try {
    registered = register(accelerator) === true;
    return {
      accelerator,
      registered,
      reset: false,
      error: null,
    };
  } catch (error) {
    const fallback = String(fallbackAccelerator || "").trim();
    if (!fallback || fallback === accelerator) {
      return {
        accelerator,
        registered: false,
        reset: true,
        error,
      };
    }

    try {
      registered = register(fallback) === true;
      return {
        accelerator: fallback,
        registered,
        reset: true,
        error,
      };
    } catch (fallbackError) {
      return {
        accelerator: fallback,
        registered: false,
        reset: true,
        error,
        fallbackError,
      };
    }
  }
}

function createLeadingEdgeCooldownHandler(handler, cooldownMs, now = Date.now) {
  const delay = Math.max(0, Number(cooldownMs) || 0);
  let lastTriggeredAt = Number.NEGATIVE_INFINITY;

  return function cooldownHandler(...args) {
    const currentTime = Number(now());
    const elapsed = currentTime - lastTriggeredAt;
    lastTriggeredAt = currentTime;
    if (elapsed >= 0 && elapsed < delay) {
      return false;
    }

    try {
      handler.apply(this, args);
      return true;
    } finally {
      // Start the quiet period after synchronous handler work. A queued duplicate
      // should not slip through merely because the first toggle was expensive.
      lastTriggeredAt = Number(now());
    }
  };
}

function shouldSuppressGamepadToggleDuringFocusTransition({
  source,
  navigationActive,
  suppressedUntil,
  now = Date.now(),
}) {
  return (
    navigationActive === true &&
    String(source || "").startsWith("keyboard:") &&
    Number(now) < Number(suppressedUntil || 0)
  );
}

module.exports = {
  createLeadingEdgeCooldownHandler,
  isSupportedHotkey,
  normalizeConfiguredHotkeyValues,
  registerHotkeyWithFallback,
  shouldSuppressGamepadToggleDuringFocusTransition,
};
