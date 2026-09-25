// Offline renderer coverage with real geometry, Reader spans, and Web Animations.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { between } = require('./helpers/overlay-startup.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-gamepad-smoke-'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
const timeout = setTimeout(() => { console.error('Gamepad smoke test timed out'); app.exit(1); }, 25_000);

app.whenReady().then(async () => {
  const view = new BrowserWindow({ show: false, width: 1100, height: 1000,
    webPreferences: { backgroundThrottling: false } });
  await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
    <style>body { background: #20232b; color: white; font: 26px sans-serif; }
    .text-block-container { position: absolute; padding: 10px; background: #303541; }
    .text-box { display: inline-block; width: 28px; height: 36px; }
    #jiten-parse-container { position: absolute; left: -99999px; top: -99999px;
      width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; }</style><body></body>`));
  for (const filename of ['dictionary_navigation.js', 'gamepad.js', 'jiten_highlight.js']) {
    await view.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8') + '\nvoid 0;');
  }
  const result = await view.webContents.executeJavaScript(`(async () => {
    window.matchMedia = () => ({ matches: false });
    const texts = ['猫だ。犬だ！鳥？', '右の文章', '𠮷は猫'];
    texts.forEach((text, lineIndex) => {
      const block = document.createElement('div');
      block.className = 'text-block-container';
      block.style.left = (lineIndex === 1 ? 600 : 80) + 'px';
      block.style.top = [80, 180, 300][lineIndex] + 'px';
      for (const glyph of text) {
        const box = document.createElement('span');
        box.className = 'text-box'; box.dataset.lineIndex = lineIndex;
        box.textContent = glyph; block.appendChild(box);
      }
      document.body.appendChild(block);
    });
    const handler = new GamepadHandler({ connectToServer: false, controllerEnabled: false,
      keyboardEnabled: false, focusOverlayOnEntry: false, blockJumpAnimation: true,
      verticalNavigation: 'spatial', initialPosition: 'start', holdNavigation: 'sentence' });
    window.handler = handler;
    handler.requestTokenizationForBlock = () => {};
    const lookups = [];
    handler.triggerDictionaryLookup = info => lookups.push(info.targetChar.textContent);
    handler.activateNavigation();
    // Keep this fixture fixed while the synthetic Reader DOM is being populated.
    handler.textMutationObserver.disconnect();
    handler.navigateCursorRight(true);
    const sentenceCharacter = handler.getTargetCharForLookup().targetChar.textContent;
    handler.navigateBlockDown();
    const spatialBlock = handler.currentBlockIndex;
    const animation = handler.blockJumpTrailAnimation;
    if (!animation) throw new Error('No block-jump animation');
    animation.pause(); animation.currentTime = 100;
    const trail = handler.blockJumpTrail;
    const trailResult = { pointerEvents: getComputedStyle(trail).pointerEvents,
      width: trail.getBoundingClientRect().width, opacity: getComputedStyle(trail).opacity };
    const api = GsmJitenHighlight;
    api.requestParse([{ text: texts[0] }, { text: texts[1] }, { text: '𠮷 は猫' }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const p = document.querySelector('p[data-line-index="2"]');
    p.innerHTML = '<span class="jiten-word mature"><ruby>𠮷<rt>よし</rt></ruby></span> は<span class="jiten-word new" wordId="42" readingIndex="0">猫</span>';
    const ranges = api.getNavigationTokens().map(token => [token.start, token.end]);
    handler.config.holdNavigation = 'new';
    handler.navigateCursorRight(true);
    const newCharacter = handler.getTargetCharForLookup().targetChar.textContent;
    const newIndex = handler.currentCursorIndex;
    handler.config.initialPosition = 'first-new';
    handler.navigateCursorLeft();
    const resumedSelections = [];
    for (const redraw of [false, true]) {
      handler.deactivateNavigation();
      if (redraw) {
        const block = handler.textBlocks[2];
        block.replaceWith(block.cloneNode(true));
      }
      handler.activateNavigation();
      resumedSelections.push([handler.currentBlockIndex, handler.getCurrentAnchorCharIndex(),
        handler.getTargetCharForLookup().targetChar.textContent]);
    }
    handler.navigateCursorRight(true);
    const jitenBindingsDisabled = handler.buttonBindings.prevJitenWordButton.disabled &&
      handler.buttonBindings.nextJitenWordButton.disabled;
    handler.config.prevJitenWordButton = 'LB';
    handler.config.nextJitenWordButton = 'RB';
    handler.config.holdNavigation = 'repeat';
    handler.refreshButtonBindings();
    p.querySelector('.mature').className = 'jiten-word young i-plus-one';
    const jitenWordSelections = [];
    for (const button of [4, 5]) {
      handler.onButtonEvent({ device: 'smoke-pad', button, pressed: true });
      handler.onButtonEvent({ device: 'smoke-pad', button, pressed: false });
      jitenWordSelections.push([handler.currentBlockIndex, handler.getCurrentAnchorCharIndex(),
        handler.getTargetCharForLookup().targetChar.textContent]);
    }
    document.querySelector('p[data-line-index="0"]').innerHTML =
      '<span class="jiten-word new">猫</span>だ。<span class="jiten-word new">犬</span>だ！<span class="jiten-word mature">鳥</span>？';
    document.querySelector('p[data-line-index="1"]').innerHTML =
      '<span class="jiten-word new">右</span>の<span class="jiten-word young i-plus-one">文章</span>';
    // DOM/block order differs from line order; screen coordinates stay fixed.
    const originalBlocks = [...handler.textBlocks];
    document.body.insertBefore(originalBlocks[2], originalBlocks[1]);
    handler.refreshTextBlocks();
    handler.selectNavigationCharacterTarget({ blockIndex: 0, charIndex: 0 });
    const readingOrderNext = [], readingOrderPrevious = [];
    for (const [button, selections] of [[5, readingOrderNext], [4, readingOrderPrevious]]) {
      for (let i = 0; i < 6; i++) {
        handler.onButtonEvent({ device: 'smoke-pad', button, pressed: true });
        handler.onButtonEvent({ device: 'smoke-pad', button, pressed: false });
        const char = handler.getTargetCharForLookup().targetChar;
        selections.push([Number(char.dataset.lineIndex), char.textContent]);
      }
    }
    originalBlocks.forEach(block => document.body.appendChild(block));
    handler.refreshTextBlocks();
    handler.selectNavigationCharacterTarget({ blockIndex: 2, charIndex: 2 });
    api.applyCardState(42, 0, ['mature']);
    const graded = api.getNavigationTokens().find(token => token.lineIndex === 2 && token.start === 4).states.includes('new');
    api.requestParse([{ text: '違う文章' }]);
    const staleCount = api.getNavigationTokens().length;
    api.setEnabled(false);
    return { sentenceCharacter, spatialBlock, trailResult, ranges, newCharacter, newIndex,
      resumedSelections, jitenBindingsDisabled, jitenWordSelections, readingOrderNext,
      readingOrderPrevious, graded, staleCount, lookups };
  })()`);
  assert.equal(result.sentenceCharacter, '犬');
  assert.equal(result.spatialBlock, 2);
  assert.equal(result.trailResult.pointerEvents, 'none');
  assert.ok(result.trailResult.width > 0);
  assert.ok(Number(result.trailResult.opacity) > 0);
  assert.deepEqual(result.ranges, [[0, 2], [4, 5]]);
  assert.equal(result.newCharacter, '猫');
  assert.equal(result.newIndex, 2);
  assert.deepEqual(result.resumedSelections, [[2, 1, 'は'], [2, 1, 'は']]);
  assert.equal(result.jitenBindingsDisabled, true);
  assert.deepEqual(result.jitenWordSelections, [[2, 0, '𠮷'], [2, 2, '猫']]);
  assert.deepEqual(result.readingOrderNext, [[0, '犬'], [1, '右'], [1, '文'], [2, '𠮷'], [2, '猫'], [0, '猫']]);
  assert.deepEqual(result.readingOrderPrevious, [[2, '猫'], [2, '𠮷'], [1, '文'], [1, '右'], [0, '犬'], [0, '猫']]);
  assert.equal(result.graded, false);
  assert.equal(result.staleCount, 0);
  assert.equal(result.lookups.at(-1), '猫');
  // Let the existing cursor/block highlight CSS transitions settle before capture.
  await view.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 300))');
  assert.equal(await view.webContents.executeJavaScript('handler.currentBlockIndex'), 2);
  fs.writeFileSync(path.join(directory, 'block-jump.png'), (await view.webContents.capturePage()).toPNG());
  const cleanup = await view.webContents.executeJavaScript(`(() => {
    handler.deactivateNavigation();
    const afterExit = document.querySelectorAll('.gsm-gamepad-jump-trail').length;
    window.matchMedia = () => ({ matches: true });
    handler.activateNavigation(); handler.navigateBlockUp();
    const reducedMotion = document.querySelectorAll('.gsm-gamepad-jump-trail').length;
    handler.destroy();
    return { afterExit, reducedMotion };
  })()`);
  assert.deepEqual(cleanup, { afterExit: 0, reducedMotion: 0 });

  // Manual activation uses the real renderer reveal and real Chromium layout.
  // Hold the reveal as a frozen background would, then let vocabulary arrive.
  const overlayHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8">' +
    [...overlayHtml.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(match => match[0]).join('') + '<body></body>'
  ));
  for (const filename of ['dictionary_navigation.js', 'gamepad.js', 'jiten_highlight.js']) {
    await view.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8') + '\nvoid 0;');
  }
  const manualResult = await view.webContents.executeJavaScript(`(async () => {
    const furiganaLayer = null;
    const updateFuriganaVisibilityState = () => {};
    const ipcRenderer = { send() {} };
    let manualHotkeyPressed = false;
    let gamepadHandler;
    ${between(overlayHtml, '  function hideTextBoxes()', '  let resizeMode = false;')}
    const block = document.createElement('div');
    block.className = 'text-block-container';
    block.style.cssText = 'left:100px;top:100px;width:240px;height:40px';
    Array.from('猫は犬を見る').forEach((glyph, index) => {
      const box = document.createElement('span');
      box.className = 'text-box'; box.dataset.lineIndex = '0'; box.textContent = glyph;
      box.style.cssText = 'left:' + (index * 40) + 'px;top:0;width:40px;height:40px';
      block.appendChild(box);
    });
    document.body.appendChild(block);
    const lookups = [], controls = [];
    gamepadHandler = new GamepadHandler({ connectToServer: false, keyboardEnabled: false,
      focusOverlayOnEntry: false, initialPosition: 'first-new',
      isOverlayReady: () => manualHotkeyPressed && !pendingManualRevealForBackground });
    gamepadHandler.requestTokenizationForBlock = () => {};
    gamepadHandler.sendDictionaryControlMessage = (action, payload) => {
      controls.push(action);
      if (action === 'lookup-point') {
        const target = document.querySelector('[data-gsm-yomitan-lookup-target="' + payload.targetId + '"]');
        lookups.push(target?.textContent || gamepadHandler.getTargetCharForLookup().targetChar.textContent);
      }
    };
    let resolveParse;
    GsmJitenHighlight.setLocalParser(() => new Promise(resolve => { resolveParse = resolve; }));
    GsmJitenHighlight.requestParse([{ text: '猫は犬を見る' }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    hideTextBoxes();
    await new Promise(resolve => setTimeout(resolve, 30));
    gamepadHandler.activateNavigation();
    manualHotkeyPressed = true;
    armDeferredManualReveal();
    await new Promise(resolve => setTimeout(resolve, 30));
    const beforeReveal = lookups.slice();
    finishDeferredManualReveal();
    await new Promise(resolve => setTimeout(resolve, 30));
    const afterReveal = lookups.slice();
    resolveParse({ tokens: [[
      { word: '猫', headword: '猫', start: 0, end: 1, knownState: [2] },
      { word: '犬', headword: '犬', start: 2, end: 3, knownState: [0] },
    ]] });
    await new Promise(resolve => setTimeout(resolve, 40));
    const selected = gamepadHandler.getTargetCharForLookup();
    const result = { beforeReveal, afterReveal, lookups: lookups.slice(),
      anchor: gamepadHandler.getCurrentAnchorCharIndex(),
      visible: selected.targetChar.getClientRects().length > 0,
      dismissedAfterLookup: controls.slice(controls.lastIndexOf('lookup-point') + 1).includes('hide-popup') };
    gamepadHandler.destroy();
    return result;
  })()`);
  assert.deepEqual(manualResult.beforeReveal, []);
  assert.deepEqual(manualResult.afterReveal, ['猫']);
  assert.deepEqual(manualResult.lookups, ['猫', '犬']);
  assert.equal(manualResult.anchor, 2);
  assert.equal(manualResult.visible, true);
  assert.equal(manualResult.dismissedAfterLookup, false);

  // Render the actual settings markup/styles for visual QA without IPC or a server.
  const settings = fs.readFileSync(path.join(__dirname, '../settings.html'), 'utf8');
  const navigationStart = settings.lastIndexOf('<h5', settings.indexOf('>Navigation Bindings</h5>'));
  const navigationEnd = settings.lastIndexOf('<label>', settings.indexOf('Token Navigation Mode', navigationStart));
  await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8">' + settings.match(/<style>[\s\S]*?<\/style>/)[0] +
    '<div class="container"><div class="setting-group">' + settings.slice(navigationStart, navigationEnd) + '</div></div>'
  ));
  assert.deepEqual(await view.webContents.executeJavaScript(
    '[...document.querySelectorAll(".gamepad-binding-input")].map(input => input.value)'
  ), ['DPad Up', 'DPad Down', 'DPad Left', 'DPad Right']);
  assert.equal(await view.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false);
  fs.writeFileSync(path.join(directory, 'navigation-bindings.png'), (await view.webContents.capturePage()).toPNG());
  const bindingStart = settings.lastIndexOf('<label>', settings.indexOf('Previous New / i+1 Jiten Word'));
  const bindingEnd = settings.lastIndexOf('<label>', settings.indexOf('Token Mode Toggle', bindingStart));
  await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8">' + settings.match(/<style>[\s\S]*?<\/style>/)[0] +
    '<div class="container"><div class="setting-group">' + settings.slice(bindingStart, bindingEnd) + '</div></div>'
  ));
  assert.equal(await view.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false);
  fs.writeFileSync(path.join(directory, 'jiten-word-bindings.png'), (await view.webContents.capturePage()).toPNG());
  const start = settings.lastIndexOf('<h5', settings.indexOf('>Navigation Experiments</h5>'));
  const end = settings.lastIndexOf('<h5', settings.indexOf('>Activation Methods</h5>', start));
  await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8">' + settings.match(/<style>[\s\S]*?<\/style>/)[0] +
    '<div class="container"><div class="setting-group">' + settings.slice(start, end) + '</div></div>'
  ));
  const overflow = await view.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth');
  assert.equal(overflow, false);
  fs.writeFileSync(path.join(directory, 'settings.png'), (await view.webContents.capturePage()).toPNG());

  const manualCardCss = fs.readFileSync(path.join(__dirname, '../components/manual-mode-card.css'), 'utf8');
  await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8">' + settings.match(/<style>[\s\S]*?<\/style>/)[0] +
    '<style>' + manualCardCss + '</style><div class="container"><div id="manual-card" class="setting-group gsm-mm-card"></div></div>'
  ));
  await view.webContents.executeJavaScript(
    fs.readFileSync(path.join(__dirname, '../components/manual-mode-card.js'), 'utf8') +
    '\nGSMManualModeCard.renderInto(document.getElementById("manual-card"));'
  );
  assert.equal(await view.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false);
  fs.writeFileSync(path.join(directory, 'manual-mode.png'), (await view.webContents.capturePage()).toPNG());
  console.log('Gamepad Electron smoke passed. Screenshots:', directory);
  clearTimeout(timeout);
  view.destroy();
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
