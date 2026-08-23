export function resolveProjectVersion(appVersion, currentProjectVersion) {
  const postReleasePrefix = `${appVersion}.post`;
  if (!currentProjectVersion.startsWith(postReleasePrefix)) {
    return appVersion;
  }

  const postReleaseNumber = currentProjectVersion.slice(postReleasePrefix.length);
  return /^[1-9]\d*$/.test(postReleaseNumber) ? currentProjectVersion : appVersion;
}
