// SPDX-License-Identifier: LGPL-3.0-only
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OVERLAY_SETTINGS_DELIVERY_CHANNEL,
  createOverlaySettingsReadyHandler,
} = require('../overlay_settings_delivery');

test('overlay settings readiness accepts only the live overlay main frame', () => {
  const mainFrame = {};
  const sent = [];
  const sender = {
    isDestroyed: () => false,
    mainFrame,
    send: (...args) => sent.push(args),
  };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: sender,
  };
  let builds = 0;
  const handler = createOverlaySettingsReadyHandler({
    getMainWindow: () => mainWindow,
    buildPayload: () => {
      builds += 1;
      return { revision: builds };
    },
  });

  assert.equal(handler({ sender: {}, senderFrame: mainFrame }), false);
  assert.equal(handler({ sender, senderFrame: {} }), false);
  assert.equal(builds, 0);
  assert.deepEqual(sent, []);

  assert.equal(handler({ sender, senderFrame: mainFrame }), true);
  assert.equal(builds, 1);
  assert.deepEqual(sent, [[OVERLAY_SETTINGS_DELIVERY_CHANNEL, { revision: 1 }]]);
});

test('each renderer-ready message resends a freshly built settings payload', () => {
  const mainFrame = {};
  const sent = [];
  const sender = {
    isDestroyed: () => false,
    mainFrame,
    send: (...args) => sent.push(args),
  };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: sender,
  };
  let revision = 40;
  const handler = createOverlaySettingsReadyHandler({
    getMainWindow: () => mainWindow,
    buildPayload: () => ({ revision: revision += 1 }),
  });

  assert.equal(handler({ sender, senderFrame: mainFrame }), true);
  assert.equal(handler({ sender, senderFrame: mainFrame }), true);
  assert.deepEqual(sent, [
    [OVERLAY_SETTINGS_DELIVERY_CHANNEL, { revision: 41 }],
    [OVERLAY_SETTINGS_DELIVERY_CHANNEL, { revision: 42 }],
  ]);
});

test('destroyed or absent overlay windows receive no settings', () => {
  const mainFrame = {};
  const sender = {
    isDestroyed: () => false,
    mainFrame,
    send: () => assert.fail('destroyed overlay must not receive settings'),
  };
  let mainWindow = null;
  let builds = 0;
  const handler = createOverlaySettingsReadyHandler({
    getMainWindow: () => mainWindow,
    buildPayload: () => {
      builds += 1;
      return {};
    },
  });

  assert.equal(handler({ sender, senderFrame: mainFrame }), false);
  mainWindow = {
    isDestroyed: () => true,
    webContents: sender,
  };
  assert.equal(handler({ sender, senderFrame: mainFrame }), false);
  mainWindow = {
    isDestroyed: () => false,
    webContents: {
      ...sender,
      isDestroyed: () => true,
    },
  };
  assert.equal(handler({ sender, senderFrame: mainFrame }), false);
  assert.equal(builds, 0);
});
