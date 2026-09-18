// SPDX-License-Identifier: LGPL-3.0-only

const OVERLAY_SETTINGS_READY_CHANNEL = 'overlay-settings-ready';
const OVERLAY_SETTINGS_DELIVERY_CHANNEL = 'load-settings';

function createOverlaySettingsReadyHandler({ getMainWindow, buildPayload }) {
  if (typeof getMainWindow !== 'function' || typeof buildPayload !== 'function') {
    throw new TypeError('Overlay settings delivery requires its window and payload builder.');
  }
  return (event) => {
    const mainWindow = getMainWindow();
    if (
      !mainWindow
      || mainWindow.isDestroyed()
      || !mainWindow.webContents
      || mainWindow.webContents.isDestroyed()
      || event?.sender !== mainWindow.webContents
      || event?.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      return false;
    }
    mainWindow.webContents.send(
      OVERLAY_SETTINGS_DELIVERY_CHANNEL,
      buildPayload(),
    );
    return true;
  };
}

module.exports = {
  OVERLAY_SETTINGS_DELIVERY_CHANNEL,
  OVERLAY_SETTINGS_READY_CHANNEL,
  createOverlaySettingsReadyHandler,
};
