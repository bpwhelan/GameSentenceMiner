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

export function expectedBackgroundUrl(api = extensionApi) {
  return extensionDocumentUrl("background.js", api);
}

export function isExactExtensionSender(sender, path, api = extensionApi, { tab = null } = {}) {
  if (sender?.id !== api?.runtime?.id || sender?.url !== extensionDocumentUrl(path, api)) return false;
  if (tab === false && sender.tab !== undefined) return false;
  if (tab === true && sender.tab === undefined) return false;
  return true;
}
