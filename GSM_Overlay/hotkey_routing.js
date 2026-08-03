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

function isGnomeWaylandSession(options = {}) {
  if (!isWaylandSession(options)) return false;
  const env = options.env || process.env;
  const desktopIdentity = [
    env.XDG_CURRENT_DESKTOP,
    env.DESKTOP_SESSION,
    env.GNOME_DESKTOP_SESSION_ID,
  ].filter(Boolean).join(":").toLowerCase();
  return desktopIdentity.includes("gnome");
}

function isEffectiveInputServerHotkeyRouting(storedSetting, options = {}) {
  return storedSetting === true || isGnomeWaylandSession(options);
}

module.exports = {
  isEffectiveInputServerHotkeyRouting,
  isWaylandSession,
};
