// Browser API and extension-origin facts shared by module contexts.
// Content scripts intentionally keep their callback-style `chrome` calls.
// SPDX-License-Identifier: GPL-3.0-or-later

export function selectExtensionApi(scope = globalThis) {
  return scope.chrome ?? null;
}

export const extensionApi = selectExtensionApi();

export function extensionDocumentUrl(path, api = extensionApi) {
  return api?.runtime?.getURL?.(path) ?? path;
}

// Chrome runs background.js as the service worker; Firefox runs it in the
// background page that the Firefox build's manifest names, and reports that
// page as an absolute URL.
export function expectedBackgroundUrl(api = extensionApi) {
  const background = api?.runtime?.getManifest?.()?.background;
  const script = background?.service_worker || background?.page || "background.js";
  return URL.canParse(script) ? script : extensionDocumentUrl(script, api);
}

// Firefox serves extension documents from moz-extension:// URLs; Chrome and the
// Electron overlay host from chrome-extension:// URLs.
export function isFirefox(api = extensionApi) {
  return api?.runtime?.getURL?.("").startsWith("moz-extension:") === true;
}

export function isExactExtensionSender(sender, path, api = extensionApi, { tab = null } = {}) {
  if (sender?.id !== api?.runtime?.id || sender?.url !== extensionDocumentUrl(path, api)) return false;
  if (tab === false && sender.tab !== undefined) return false;
  if (tab === true && sender.tab === undefined) return false;
  return true;
}
