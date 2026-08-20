function normalizeOzoneValue(value) {
  return String(value || "").trim().toLowerCase();
}

function getCommandLineSwitchValue(argv, switchName) {
  const prefix = `--${switchName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument.startsWith(prefix)) {
      return argument.slice(prefix.length);
    }
    if (argument === `--${switchName}`) {
      const next = String(argv[index + 1] || "");
      if (next && !next.startsWith("--")) {
        return next;
      }
    }
  }
  return "";
}

function isWaylandEnvironment(env) {
  return normalizeOzoneValue(env.XDG_SESSION_TYPE) === "wayland" ||
    String(env.WAYLAND_DISPLAY || "").trim().length > 0;
}

function isGnomeDesktopEnvironment(env) {
  const desktopIdentity = [
    env.XDG_CURRENT_DESKTOP,
    env.DESKTOP_SESSION,
    env.GNOME_DESKTOP_SESSION_ID,
  ].filter(Boolean).join(":").toLowerCase();
  return desktopIdentity.includes("gnome");
}

function isXWaylandOverlayEnvironment(options = {}) {
  const env = options.env || {};
  if (options.platform !== "linux") return false;
  const override = normalizeOzoneValue(env.GSM_OVERLAY_XWAYLAND_FEATURES);
  if (override === "0") return false;
  if (!isWaylandEnvironment(env) || normalizeOzoneValue(options.ozonePlatform) !== "x11") {
    return false;
  }

  // GNOME/Mutter is the tested default compatibility envelope. Other Linux
  // Wayland compositors keep Electron's native backend unless explicitly
  // opted in for support/testing. The override cannot bypass the required
  // Wayland-session and X11-backend checks above.
  return override === "1" || isGnomeDesktopEnvironment(env);
}

function resolveAutomaticOzonePlatform(env, source) {
  return isWaylandEnvironment(env)
    ? { platform: "wayland", reason: `${source}=auto in a Wayland session` }
    : { platform: "x11", reason: `${source}=auto outside a Wayland session` };
}

function resolveLinuxOzonePlatform(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") {
    return { platform: "other", reason: `platform=${platform}` };
  }

  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const electronMajor = Number.parseInt(String(options.electronVersion || process.versions.electron || ""), 10);
  const ozonePlatform = normalizeOzoneValue(
    options.ozonePlatform || getCommandLineSwitchValue(argv, "ozone-platform")
  );
  if (ozonePlatform === "x11" || ozonePlatform === "wayland") {
    return { platform: ozonePlatform, reason: `--ozone-platform=${ozonePlatform}`, appendSwitch: false };
  }
  if (ozonePlatform === "auto") {
    return resolveAutomaticOzonePlatform(env, "--ozone-platform");
  }

  const ozonePlatformHint = normalizeOzoneValue(
    options.ozonePlatformHint || getCommandLineSwitchValue(argv, "ozone-platform-hint")
  );
  if (ozonePlatformHint === "x11" || ozonePlatformHint === "wayland") {
    return { platform: ozonePlatformHint, reason: `--ozone-platform-hint=${ozonePlatformHint}`, appendSwitch: false };
  }
  if (ozonePlatformHint === "auto") {
    return resolveAutomaticOzonePlatform(env, "--ozone-platform-hint");
  }

  const envOzonePlatformHint = normalizeOzoneValue(env.ELECTRON_OZONE_PLATFORM_HINT);
  // Electron removed ELECTRON_OZONE_PLATFORM_HINT in v38. Treating it as the
  // active backend after that point can enable X11-only behavior on a Wayland
  // window. The standalone relaunch path translates a valid preference to an
  // explicit --ozone-platform switch instead.
  if ((!Number.isFinite(electronMajor) || electronMajor < 38) &&
      (envOzonePlatformHint === "x11" || envOzonePlatformHint === "wayland")) {
    return {
      platform: envOzonePlatformHint,
      reason: `ELECTRON_OZONE_PLATFORM_HINT=${envOzonePlatformHint}`,
      appendSwitch: false,
    };
  }

  if (
    options.forceX11OnWayland &&
    isXWaylandOverlayEnvironment({ platform, env, ozonePlatform: "x11" })
  ) {
    return {
      platform: "x11",
      reason: "GSM GNOME/Mutter XWayland compatibility default",
      appendSwitch: true,
    };
  }

  if (Number.isFinite(electronMajor) && electronMajor >= 38) {
    return resolveAutomaticOzonePlatform(env, "Electron default ozone platform");
  }

  return { platform: "x11", reason: "legacy Electron default ozone platform" };
}

function resolveLinuxOzoneRelaunch(argv, env, platform, appReady, inProcess) {
  const args = Array.isArray(argv) ? argv : [];
  const relaunchMarker = "--gsm-ozone-relaunch";
  if (
    platform !== "linux" ||
    appReady ||
    inProcess ||
    !isWaylandEnvironment(env || {}) ||
    args.includes(relaunchMarker)
  ) {
    return { relaunch: false, args: [] };
  }

  if (!isXWaylandOverlayEnvironment({ platform, env: env || {}, ozonePlatform: "x11" })) {
    return { relaunch: false, args: [] };
  }

  const hasExplicitOzonePreference = !!(
    getCommandLineSwitchValue(args, "ozone-platform") ||
    getCommandLineSwitchValue(args, "ozone-platform-hint")
  );
  if (!hasExplicitOzonePreference) {
    const envHint = normalizeOzoneValue((env || {}).ELECTRON_OZONE_PLATFORM_HINT);
    if (envHint === "x11") {
      return {
        relaunch: true,
        args: [
          ...args.slice(1).filter((argument) => !String(argument).startsWith(relaunchMarker)),
          "--ozone-platform=x11",
          relaunchMarker,
        ],
      };
    }
    if (envHint === "wayland") {
      return { relaunch: false, args: [] };
    }
  }

  const desiredPlatform = resolveLinuxOzonePlatform({
    platform,
    env: env || {},
    argv: args,
    forceX11OnWayland: true,
  });
  if (desiredPlatform.platform !== "x11" || !desiredPlatform.appendSwitch) {
    return { relaunch: false, args: [] };
  }

  return {
    relaunch: true,
    args: [
      ...args.slice(1).filter((argument) => !String(argument).startsWith(relaunchMarker)),
      "--ozone-platform=x11",
      relaunchMarker,
    ],
  };
}

module.exports = {
  getCommandLineSwitchValue,
  isXWaylandOverlayEnvironment,
  resolveLinuxOzoneRelaunch,
  resolveLinuxOzonePlatform,
};
