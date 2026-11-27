const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { line, overlayRoot, readRenderer } = require('./helpers/overlay-render.cjs');

test('minimizing the floating box keeps current and incoming OCR available', async t => {
  const dom = new JSDOM(readRenderer(), {
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    url: 'http://gsm.localhost/overlay/index.html',
  });
  const { window } = dom;
  t.after(() => window.close());
  const { document } = window;
  const ipc = new EventEmitter();
  const sent = [];
  ipc.send = channel => sent.push(channel);
  ipc.invoke = async () => null;
  window.require = name => name === 'electron' ? { ipcRenderer: ipc } : require(path.resolve(overlayRoot, name));
  // Put the OCR word underneath the pinned box in jsdom's layout-free DOM.
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(20, 30, 100, 40);
  for (const script of document.scripts) {
    const src = script.getAttribute('src');
    vm.runInContext(src ? readFileSync(path.join(overlayRoot, src), 'utf8') : script.textContent, dom.getInternalVMContext());
  }

  const mainBox = document.getElementById('main-box');
  const settings = { hideOnStartup: false, pinned: true, manualMode: false };
  ipc.emit('load-settings', {}, settings);
  async function sendLine(text) {
    const payload = { type: 'word_coordinates', data: [line(text, 0.1, 0.4, 0.2, 0.04)] };
    ipc.emit('overlay-websocket-data', {}, { data: JSON.stringify(payload) });
    await new Promise(resolve => setImmediate(resolve));
    return document.querySelector('.text-box');
  }

  const original = await sendLine('猫');
  assert.equal(original.style.display, 'none');
  document.getElementById('btn-minimize').click();
  assert.equal(mainBox.style.display, 'none');
  assert.ok(!sent.includes('app-minimize'));
  assert.equal(original.style.display, 'flex');
  assert.equal(document.querySelector('.text-box'), original);

  ipc.emit('load-settings', {}, settings);
  assert.equal(mainBox.style.display, 'none');
  const next = await sendLine('犬');
  assert.equal(next.textContent, '犬');
  assert.equal(next.style.display, 'flex');
  ipc.emit('toggle-main-box', {});
  assert.equal(mainBox.style.display, '');
  assert.equal(next.style.display, 'none');
  assert.ok(sent.includes('overlay-main-box-shown'));
});
