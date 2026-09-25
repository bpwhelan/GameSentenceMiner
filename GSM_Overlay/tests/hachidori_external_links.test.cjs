// SPDX-License-Identifier: LGPL-3.0-only
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createHachidoriExternalLinkHandler,
  hasLoadedHachidoriExtension,
  normalizeExternalHttpUrl,
} = require('../hachidori_external_links');

test('Hachidori external URLs require explicit credential-free HTTP(S)', () => {
  assert.equal(
    normalizeExternalHttpUrl(' HTTPS://EXAMPLE.COM:443/日本?q=蜂%20%26%20犬 '),
    'https://example.com/%E6%97%A5%E6%9C%AC?q=%E8%9C%82%20%26%20%E7%8A%AC',
  );
  assert.equal(normalizeExternalHttpUrl('http://127.0.0.1:7275/reference'), 'http://127.0.0.1:7275/reference');
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'file:///tmp/unsafe',
    'chrome://settings',
    'https:example.test/path',
    'https:/example.test/path',
    'https://',
    'https://[::1',
    'https://user@example.test/',
    'https://user:pass@example.test/',
    '\nhttps://example.test/',
    'https://example.test/\r',
    'https://exam\tple.test/',
    { href: 'https://example.test/' },
  ]) {
    assert.equal(normalizeExternalHttpUrl(value), null, String(value));
  }
});

test('the bridge opens once only for the live GSM overlay sender', async () => {
  const mainFrame = {};
  const sender = { isDestroyed: () => false, mainFrame };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: sender,
  };
  const opened = [];
  const handler = createHachidoriExternalLinkHandler({
    getMainWindow: () => mainWindow,
    isHachidoriActive: () => true,
    openExternal: async (url) => { opened.push(url); },
  });
  assert.deepEqual(await handler({ sender, senderFrame: mainFrame }, {
    url: 'https://example.test/辞書?q=蜂%20%26%20犬',
    active: false,
  }), { opened: true });
  assert.deepEqual(opened, [
    'https://example.test/%E8%BE%9E%E6%9B%B8?q=%E8%9C%82%20%26%20%E7%8A%AC',
  ]);

  for (const [event, payload] of [
    [{ sender: {}, senderFrame: mainFrame }, { url: 'https://example.test/' }],
    [{ sender, senderFrame: {} }, { url: 'https://example.test/' }],
    [{ sender, senderFrame: mainFrame }, { url: 'javascript:alert(1)' }],
    [{ sender, senderFrame: mainFrame }, { url: 'https://user:pass@example.test/' }],
    [{ sender, senderFrame: mainFrame }, { url: '\nhttps://example.test/' }],
    [{ sender, senderFrame: mainFrame }, { url: 'https:example.test/' }],
    [{ sender, senderFrame: mainFrame }, { url: 'https://example.test/', active: 'yes' }],
    [{ sender, senderFrame: mainFrame }, null],
  ]) {
    await assert.rejects(handler(event, payload));
  }
  assert.equal(opened.length, 1);
});

test('the bridge rejects a subframe and an inactive or unloaded Hachidori reader', async () => {
  const mainFrame = {};
  const sender = { isDestroyed: () => false, mainFrame };
  let active = true;
  let attempts = 0;
  const handler = createHachidoriExternalLinkHandler({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: sender,
    }),
    isHachidoriActive: () => active,
    openExternal: async () => { attempts += 1; },
  });
  await assert.rejects(
    handler({ sender, senderFrame: {} }, { url: 'https://example.test/' }),
    /main frame/u,
  );
  active = false;
  await assert.rejects(
    handler({ sender, senderFrame: mainFrame }, { url: 'https://example.test/' }),
    /selected and loaded/u,
  );
  assert.equal(attempts, 0);
});

test('only a nonempty loaded Hachidori extension identity is active', () => {
  assert.equal(hasLoadedHachidoriExtension(undefined), false);
  assert.equal(hasLoadedHachidoriExtension(null), false);
  assert.equal(hasLoadedHachidoriExtension({}), false);
  assert.equal(hasLoadedHachidoriExtension({ id: '' }), false);
  assert.equal(hasLoadedHachidoriExtension({ id: 123 }), false);
  assert.equal(hasLoadedHachidoriExtension({ id: 'loaded-extension-id' }), true);
});

test('destroyed windows and OS-browser failures fail closed without retry', async () => {
  const mainFrame = {};
  const sender = { isDestroyed: () => false, mainFrame };
  let destroyed = true;
  let attempts = 0;
  const handler = createHachidoriExternalLinkHandler({
    getMainWindow: () => ({
      isDestroyed: () => destroyed,
      webContents: sender,
    }),
    isHachidoriActive: () => true,
    openExternal: async () => {
      attempts += 1;
      throw new Error('desktop opener failed');
    },
  });
  await assert.rejects(
    handler({ sender, senderFrame: mainFrame }, { url: 'https://example.test/' }),
    /only from the GSM overlay main frame/u,
  );
  assert.equal(attempts, 0);
  destroyed = false;
  await assert.rejects(
    handler({ sender, senderFrame: mainFrame }, { url: 'https://example.test/' }),
    /desktop opener failed/u,
  );
  assert.equal(attempts, 1);
});
