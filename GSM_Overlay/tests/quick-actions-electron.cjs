const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-quick-actions-'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
const timeout = setTimeout(() => { console.error('Quick actions render test timed out'); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const view = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { backgroundThrottling: false, offscreen: true } });
  const run = async source => {
    const result = await view.webContents.executeJavaScript(`(async () => {
      try { return await eval(${JSON.stringify(source)}); }
      catch (error) { return { fixtureError: error.stack }; }
    })()`);
    if (result?.fixtureError) throw new Error(result.fixtureError);
    return result;
  };
  await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head></head>
    <body style="margin:0;background:#202a32;color:#eee;font:24px system-ui">
      <div class="text-block-container" style="position:absolute;left:80px;top:140px" data-translation-source="猫は窓の外を見ている。">
        ${Array.from('猫は窓の外を見ている。', text => `<span class="text-box" style="display:inline-block">${text}</span>`).join('')}
      </div>
    </body></html>`));
  for (const filename of ['quick_actions.js', 'dictionary_navigation.js', 'gamepad.js']) {
    await run(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8') + '\nvoid 0;');
  }
  await run(`(() => {
    const style = document.createElement('style'); style.textContent = ${JSON.stringify(fs.readFileSync(path.join(__dirname, '../quick_actions.css'), 'utf8'))}; document.head.append(style);
    window.calls = []; window.lookups = 0;
    window.panel = new GSMQuickActions.QuickActions({ document,
      runAction: async action => { calls.push(action); return { paused: action === 'toggle-intake', canReplay: true }; },
      explain: options => calls.push(options), translate: () => calls.push('translation'), toggleFurigana: () => calls.push('furigana'),
      onOpenChange: () => window.handler?.stopNavigationRepeats(),
    });
    window.handler = new GamepadHandler({ connectToServer: false, focusOverlayOnEntry: false,
      activationMode: 'toggle', getQuickActions: () => panel, initialPosition: 'start' });
    handler.requestTokenizationForBlock = () => {};
    handler.triggerDictionaryLookup = () => lookups++;
    handler.activateNavigation();
    window.anchor = handler.currentCursorIndex;
    window.initialLookups = lookups;
    let time = 1000;
    handler.getToggleTimestamp = () => time;
    window.press = button => {
      time += 300;
      handler.onButtonEvent({ device: 'pad', button, pressed: true });
      handler.onButtonEvent({ device: 'pad', button, pressed: false });
    };
    press(9);
  })()`);
  await run('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.equal(await run('panel.isOpen'), true);
  assert.equal(await run(`document.querySelectorAll('#gsm-quick-actions .quick-actions-button').length`), 4);
  assert.equal(await run(`(() => { const rect = panel.root.getBoundingClientRect(); return rect.left >= 0 && rect.bottom <= innerHeight; })()`), true);
  const output = directory;
  fs.writeFileSync(path.join(output, 'quick-actions-preview.png'), (await view.webContents.capturePage()).toPNG());
  await run('press(0)'); await run('new Promise(resolve => setTimeout(resolve, 0))');
  assert.equal(await run(`document.querySelector('[data-action="pause-input"]').textContent`), 'Resume text input');
  await run('press(13); press(15); press(0)');
  assert.equal(await run('panel.view'), 'translate');
  assert.equal(await run('panel.items().length'), 7);
  fs.writeFileSync(path.join(output, 'quick-actions-translation-preview.png'), (await view.webContents.capturePage()).toPNG());
  await run('press(15); press(0)');
  assert.equal(await run('panel.view'), 'result');
  await run(`panel.showResult(Array.from({length: 60}, (_, i) => 'Explanation line ' + i).join('\\n'))`);
  await run('press(13)'); await run('new Promise(resolve => setTimeout(resolve, 250))');
  assert.equal(await run('panel.content.scrollTop > 0'), true);
  assert.equal(await run('lookups === initialLookups && handler.currentCursorIndex === anchor'), true);
  await run('press(1); press(1); press(1)');
  assert.equal(await run('panel.isOpen'), false);
  assert.equal(await run('handler.isNavigationActive()'), true);
  await run('handler.destroy()');
  console.log('Quick actions: Chromium layout, controller routing, pause state, study submenu, result scrolling, and selection preservation passed.');
  clearTimeout(timeout); view.destroy(); app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
