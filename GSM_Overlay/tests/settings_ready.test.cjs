const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('settings announces readiness only after controls and listeners initialize', () => {
    const calls = [];
    const context = { GSMSettingsHome: { render() {} }, ipcRenderer: { send: (...args) => calls.push(args) } };
    for (const name of ['initializeSettingBindings', 'syncDisableInteractionSubOptionsUi',
        'updateControllerActivationFieldState', 'updateTokenizerBackendFieldState',
        'initializeSettingsTabs', 'renderOverlayPresetCards', 'applyPlatformSpecifics', 'initializeSettingsInputs']) {
        context[name] = () => calls.push([name]);
    }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../settings/bootstrap.js'), 'utf8'), context);
    assert.deepEqual(calls.at(-1), ['overlay-settings-ready']);
});
