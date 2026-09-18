// SPDX-License-Identifier: LGPL-3.0-only

function isHachidoriSpeechCaptureFrame(frame, extensionId) {
  if (!frame || typeof frame.url !== 'string' || typeof extensionId !== 'string' || !extensionId) {
    return false;
  }
  try {
    const url = new URL(frame.url);
    return url.protocol === 'chrome-extension:'
      && url.hostname === extensionId
      && url.pathname === '/speech-capture.html'
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function isHachidoriOrigin(securityOrigin, extensionId) {
  return typeof securityOrigin === 'string'
    && securityOrigin.replace(/\/+$/u, '') === `chrome-extension://${extensionId}`;
}

function createHachidoriSpeechCaptureHandler({
  getExtensionId,
  getCaptureFrame,
  isHachidoriActive,
}) {
  if (typeof getExtensionId !== 'function'
      || typeof getCaptureFrame !== 'function'
      || typeof isHachidoriActive !== 'function') {
    throw new TypeError(
      'Hachidori speech capture requires extension identity, capture frame, and active-reader callbacks.',
    );
  }
  return (request, callback) => {
    const extensionId = getExtensionId();
    const captureFrame = getCaptureFrame();
    const allowed = isHachidoriActive() === true
      && request?.audioRequested === true
      && request?.videoRequested === true
      && request?.frame === captureFrame
      && isHachidoriOrigin(request.securityOrigin, extensionId)
      && isHachidoriSpeechCaptureFrame(request.frame, extensionId);
    callback(allowed ? {
      audio: request.frame,
      video: request.frame,
      enableLocalEcho: true,
    } : {});
  };
}

function installHachidoriSpeechCapture(electronSession, options) {
  if (typeof electronSession?.setDisplayMediaRequestHandler !== 'function') {
    throw new TypeError('The Electron session cannot install a display-media handler.');
  }
  electronSession.setDisplayMediaRequestHandler(createHachidoriSpeechCaptureHandler(options));
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    electronSession.setDisplayMediaRequestHandler(null);
  };
}

module.exports = {
  createHachidoriSpeechCaptureHandler,
  installHachidoriSpeechCapture,
  isHachidoriSpeechCaptureFrame,
};
