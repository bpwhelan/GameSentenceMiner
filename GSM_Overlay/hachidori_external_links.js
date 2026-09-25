// SPDX-License-Identifier: LGPL-3.0-only

const HACHIDORI_EXTERNAL_LINK_CHANNEL = 'hachidori-open-external';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const EXPLICIT_HTTP_PATTERN = /^https?:\/\//iu;

function hasLoadedHachidoriExtension(extension) {
  return typeof extension?.id === 'string' && extension.id.length > 0;
}

function normalizeExternalHttpUrl(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) {
    return null;
  }
  const source = value.trim();
  if (!EXPLICIT_HTTP_PATTERN.test(source)) {
    return null;
  }
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function createHachidoriExternalLinkHandler({ getMainWindow, isHachidoriActive, openExternal }) {
  if (
    typeof getMainWindow !== 'function' ||
    typeof isHachidoriActive !== 'function' ||
    typeof openExternal !== 'function'
  ) {
    throw new TypeError('The Hachidori external-link bridge requires its window, reader state, and opener.');
  }
  return async (event, payload) => {
    const mainWindow = getMainWindow();
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !mainWindow.webContents ||
      mainWindow.webContents.isDestroyed() ||
      event?.sender !== mainWindow.webContents ||
      event?.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      throw new Error('Hachidori external links are accepted only from the GSM overlay main frame.');
    }
    if (isHachidoriActive() !== true) {
      throw new Error('Hachidori external links require the Hachidori reader to be selected and loaded.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('Hachidori external-link request is invalid.');
    }
    const url = normalizeExternalHttpUrl(payload.url);
    if (!url) {
      throw new TypeError('Hachidori external-link URL is invalid.');
    }
    const active = payload.active === undefined ? true : payload.active;
    if (typeof active !== 'boolean') {
      throw new TypeError('Hachidori external-link activation is invalid.');
    }
    try {
      await openExternal(url);
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      throw new Error(`The system browser could not open the Hachidori link${detail}`);
    }
    return { opened: true };
  };
}

module.exports = {
  HACHIDORI_EXTERNAL_LINK_CHANNEL,
  createHachidoriExternalLinkHandler,
  hasLoadedHachidoriExtension,
  normalizeExternalHttpUrl,
};
