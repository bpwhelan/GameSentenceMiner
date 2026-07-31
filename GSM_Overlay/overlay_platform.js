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
  return normalizeOzoneValue(env.XDG_SESSION_TYPE) === "wayland";
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
  const ozonePlatform = normalizeOzoneValue(
    options.ozonePlatform || getCommandLineSwitchValue(argv, "ozone-platform")
  );
  if (ozonePlatform === "x11" || ozonePlatform === "wayland") {
    return { platform: ozonePlatform, reason: `--ozone-platform=${ozonePlatform}` };
  }
  if (ozonePlatform === "auto") {
    return resolveAutomaticOzonePlatform(env, "--ozone-platform");
  }

  const ozonePlatformHint = normalizeOzoneValue(
    options.ozonePlatformHint || getCommandLineSwitchValue(argv, "ozone-platform-hint")
  );
  if (ozonePlatformHint === "x11" || ozonePlatformHint === "wayland") {
    return { platform: ozonePlatformHint, reason: `--ozone-platform-hint=${ozonePlatformHint}` };
  }
  if (ozonePlatformHint === "auto") {
    return resolveAutomaticOzonePlatform(env, "--ozone-platform-hint");
  }

  const electronMajor = Number.parseInt(String(options.electronVersion || process.versions.electron || ""), 10);
  const environmentHint = normalizeOzoneValue(env.ELECTRON_OZONE_PLATFORM_HINT);
  const supportsEnvironmentHint = !Number.isFinite(electronMajor) || electronMajor < 38;
  if (supportsEnvironmentHint && (environmentHint === "x11" || environmentHint === "wayland")) {
    return { platform: environmentHint, reason: `ELECTRON_OZONE_PLATFORM_HINT=${environmentHint}` };
  }
  if (supportsEnvironmentHint && environmentHint === "auto") {
    return resolveAutomaticOzonePlatform(env, "ELECTRON_OZONE_PLATFORM_HINT");
  }

  if (Number.isFinite(electronMajor) && electronMajor >= 38) {
    return resolveAutomaticOzonePlatform(env, "Electron default ozone platform");
  }

  return { platform: "x11", reason: "legacy Electron default ozone platform" };
}

module.exports = {
  getCommandLineSwitchValue,
  resolveLinuxOzonePlatform,
};
