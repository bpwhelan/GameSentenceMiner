// SPDX-License-Identifier: LGPL-3.0-only
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createHachidoriSpeechCaptureHandler,
  installHachidoriSpeechCapture,
} = require('../hachidori_speech_capture');

function request(overrides = {}) {
  return {
    audioRequested: true,
    videoRequested: true,
    securityOrigin: 'chrome-extension://hachidori-id',
    frame: { url: 'chrome-extension://hachidori-id/speech-capture.html' },
    userGesture: false,
    ...overrides,
  };
}

test('GSM grants only the active Hachidori speech-capture frame with audible local echo', () => {
  const captureFrame = request().frame;
  const handler = createHachidoriSpeechCaptureHandler({
    getExtensionId: () => 'hachidori-id',
    getCaptureFrame: () => captureFrame,
    isHachidoriActive: () => true,
  });
  let granted = null;
  handler(request({ frame: captureFrame }), streams => { granted = streams; });
  assert.deepEqual(granted, {
    audio: captureFrame,
    video: captureFrame,
    enableLocalEcho: true,
  });
});

test('GSM rejects unrelated origins, pages, media shapes, and inactive readers', () => {
  let active = true;
  const captureFrame = request().frame;
  const handler = createHachidoriSpeechCaptureHandler({
    getExtensionId: () => 'hachidori-id',
    getCaptureFrame: () => captureFrame,
    isHachidoriActive: () => active,
  });
  for (const value of [
    request(),
    request({ securityOrigin: 'https://example.test' }),
    request({ securityOrigin: 'chrome-extension://other-id' }),
    request({ frame: { url: 'chrome-extension://hachidori-id/offscreen.html' } }),
    request({ frame: null }),
    request({ audioRequested: false }),
    request({ videoRequested: false }),
  ]) {
    let result = null;
    handler(value, streams => { result = streams; });
    assert.deepEqual(result, {});
  }
  active = false;
  let inactive = null;
  handler(request({ frame: captureFrame }), streams => { inactive = streams; });
  assert.deepEqual(inactive, {});
});

test('installing and removing the capture policy updates one Electron session handler', () => {
  const handlers = [];
  const session = {
    setDisplayMediaRequestHandler(handler) {
      handlers.push(handler);
    },
  };
  const uninstall = installHachidoriSpeechCapture(session, {
    getExtensionId: () => 'hachidori-id',
    getCaptureFrame: () => request().frame,
    isHachidoriActive: () => true,
  });
  assert.equal(typeof handlers[0], 'function');
  uninstall();
  assert.equal(handlers[1], null);
  uninstall();
  assert.equal(handlers.length, 2);
});
