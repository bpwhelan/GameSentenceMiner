const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

test('only the matching managed overlay handles a shutdown request', () => {
  let shutdowns = 0;
  const context = vm.createContext({
    process: { env: { GSM_OVERLAY_LAUNCH_ID: 'managed-overlay' } },
    OVERLAY_WS_COMMAND_OPEN_SETTINGS: 'open-overlay-settings',
    requestOverlayShutdown() { shutdowns++; },
  });
  vm.runInContext(between(main, 'function handleOverlayWebSocketControlMessage(', 'function requestGSMProfileState('), context);
  const message = { type: 'shutdown-overlay', launchId: 'managed-overlay' };
  assert.equal(context.handleOverlayWebSocketControlMessage('backend-connector', message), true);
  assert.equal(shutdowns, 1);
  assert.equal(context.handleOverlayWebSocketControlMessage('ws2', JSON.stringify(message)), true);
  assert.equal(shutdowns, 2);

  context.handleOverlayWebSocketControlMessage('ws1', message);
  context.handleOverlayWebSocketControlMessage('ws2', { ...message, launchId: 'other-overlay' });
  context.handleOverlayWebSocketControlMessage('ws2', { type: 'shutdown-overlay' });
  delete context.process.env.GSM_OVERLAY_LAUNCH_ID;
  context.handleOverlayWebSocketControlMessage('ws2', message);
  context.handleOverlayWebSocketControlMessage('ws2', { type: 'shutdown-overlay' });
  assert.equal(shutdowns, 2);
});
