function isWaylandSession(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== "linux") {
    return false;
  }

  const sessionType = String(env.XDG_SESSION_TYPE || "").trim().toLowerCase();
  const waylandDisplay = String(env.WAYLAND_DISPLAY || "").trim();
  return sessionType === "wayland" || waylandDisplay.length > 0;
}

function isEffectiveInputServerHotkeyRouting(storedSetting, options = {}) {
  return storedSetting === true || isWaylandSession(options);
}

module.exports = {
  isEffectiveInputServerHotkeyRouting,
  isWaylandSession,
};
