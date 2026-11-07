const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GuideSceneSettings, VN_GUIDE_SCENE_SETTING_KEYS } = require('../vn_guide_scene_settings');

const defaults = { vnGuideEnabled: false, vnGuideUrl: '', vnGuideRoute: '' };
const first = { vnGuideEnabled: true, vnGuideUrl: 'https://example.github.io/VN-Guide/one/', vnGuideRoute: 'one' };
const second = { vnGuideEnabled: true, vnGuideUrl: 'C:\\guides\\two', vnGuideRoute: 'two' };
const snapshot = settings => Object.fromEntries(VN_GUIDE_SCENE_SETTING_KEYS.map(key => [key, settings[key]]));

test('guide selections follow scenes independently of overlay profiles and survive restarts', () => {
  const settings = { ...defaults };
  let scenes = new GuideSceneSettings(settings, defaults);
  scenes.select('Game One', 'Default');
  Object.assign(settings, first);
  scenes.record('vnGuideUrl');
  scenes.select('Game Two', 'Default');
  assert.deepEqual(snapshot(settings), defaults);
  Object.assign(settings, second);
  scenes.record('vnGuideRoute');
  scenes.select('Game One', 'Other profile');
  assert.deepEqual(snapshot(settings), first);
  scenes.select('Game Two', 'Default');
  assert.deepEqual(snapshot(settings), second);
  const persisted = JSON.parse(JSON.stringify(settings));
  scenes = new GuideSceneSettings(persisted, defaults);
  scenes.select('Game One', 'Default');
  assert.deepEqual(snapshot(persisted), first);
  scenes.select('New Game', 'Default');
  assert.deepEqual(snapshot(persisted), defaults, 'the previous scene must not seed a new game after restart');
});

test('existing global and profile selections migrate once into the first scene using them', () => {
  for (const profilesEnabled of [false, true]) {
    const settings = { ...first, overlaySettingsProfilesEnabled: profilesEnabled, overlayActiveProfileName: 'VN',
      overlayProfileSettings: { VN: { ...first }, Other: { ...second } } };
    const scenes = new GuideSceneSettings(settings, defaults);
    scenes.select('Game One', 'VN');
    assert.deepEqual(snapshot(settings), first);
    scenes.select('New VN', 'VN');
    assert.deepEqual(snapshot(settings), defaults);
    scenes.select('Game Two', 'Other');
    assert.deepEqual(snapshot(settings), profilesEnabled ? second : defaults);
  }
});

test('an intentionally empty or disabled scene stays separate, and missing capture does not change the scene', () => {
  const settings = { ...first };
  const scenes = new GuideSceneSettings(settings, defaults);
  scenes.select('Game One', 'Default');
  scenes.select('No guide', 'Default');
  scenes.select('Game One', 'Default');
  settings.vnGuideEnabled = false;
  scenes.record('vnGuideEnabled');
  assert.equal(scenes.select('', 'Default'), false);
  assert.equal(scenes.select(undefined, 'Default'), false);
  assert.equal(scenes.scene, 'Game One');
  scenes.select('No guide', 'Default');
  assert.deepEqual(snapshot(settings), defaults);
  scenes.select('Game One', 'Default');
  assert.deepEqual(snapshot(settings), { ...first, vnGuideEnabled: false });
});

test('selecting a guide before OBS is ready attaches it to the first observed scene', () => {
  const settings = { ...defaults };
  let scenes = new GuideSceneSettings(settings, defaults);
  Object.assign(settings, second);
  scenes.record('vnGuideRoute');
  const persisted = JSON.parse(JSON.stringify(settings));
  scenes = new GuideSceneSettings(persisted, defaults);
  scenes.select('Game Two', 'Default');
  assert.deepEqual(snapshot(persisted), second);
  scenes.select('Another Game', 'Default');
  assert.deepEqual(snapshot(persisted), defaults);
});

test('special scene names are persisted as ordinary keys and display preferences remain untouched', () => {
  const settings = { ...defaults, vnGuideMode: 'always', vnGuideNextHotkey: 'F8' };
  const scenes = new GuideSceneSettings(settings, defaults);
  scenes.select('__proto__', 'Default');
  Object.assign(settings, first);
  scenes.record('vnGuideUrl');
  scenes.select('constructor', 'Default');
  assert.deepEqual(snapshot(settings), defaults);
  scenes.select('__proto__', 'Default');
  assert.deepEqual(snapshot(settings), first);
  assert.equal(settings.vnGuideMode, 'always');
  assert.equal(settings.vnGuideNextHotkey, 'F8');
});

test('production settings exclude scene selections from profile snapshots and persist route changes to the scene', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const settings = { ...first, vnGuideMode: 'always', overlaySettingsProfilesEnabled: true, overlayActiveProfileName: 'VN',
    overlayProfileSettings: { VN: { ...first, vnGuideMode: 'always' }, Other: { ...second, vnGuideMode: 'hotkey' } } };
  const scenes = new GuideSceneSettings(settings, defaults);
  scenes.select('Game One', 'VN');
  const context = vm.createContext({
    userSettings: settings, vnGuideSceneSettings: scenes, VN_GUIDE_SCENE_SETTING_KEYS,
    DEFAULT_USER_SETTINGS: { ...defaults, vnGuideMode: 'auto' },
    DEFAULT_GSM_PROFILE_NAME: 'Default',
    OVERLAY_NON_PROFILE_SETTING_KEYS: new Set(),
    OVERLAY_PROFILE_SETTINGS_KEY: 'overlayProfileSettings', OVERLAY_ACTIVE_PROFILE_KEY: 'overlayActiveProfileName',
    OVERLAY_SETTINGS_PROFILES_ENABLED_KEY: 'overlaySettingsProfilesEnabled',
  });
  for (const name of ['cloneOverlaySettingValue', 'isOverlayProfileScopedSetting', 'buildOverlayProfileSnapshot',
    'normalizeOverlayProfileName', 'getOverlayProfileSettingsContainer', 'persistOverlaySettingForActiveProfile', 'setOverlaySettingValue']) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0], context);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(context.buildOverlayProfileSnapshot())), { vnGuideMode: 'always' });
  context.setOverlaySettingValue('vnGuideRoute', 'continued-route');
  scenes.select('Other Game', 'VN');
  scenes.select('Game One', 'Other');
  assert.equal(settings.vnGuideRoute, 'continued-route');
  assert.equal(settings.overlayProfileSettings.VN.vnGuideRoute, 'one', 'scene writes must not mutate the legacy profile');
});

test('capture snapshots switch production guide settings before granting capture, without repeating work on heartbeats', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const settings = { ...first };
  const scenes = new GuideSceneSettings(settings, defaults);
  const configured = [], saved = [], hidden = [];
  let profileReads = 0;
  const context = vm.createContext({
    userSettings: settings, vnGuideSceneSettings: scenes,
    getCurrentGSMProfileName: () => { profileReads++; return 'Default'; },
    vnGuideController: { setAvailable: (...args) => hidden.push(args) },
    reconfigureOverlayRuntimeForSettingsChange: () => configured.push(snapshot(settings)),
    saveSettings: () => saved.push(JSON.parse(JSON.stringify(settings))), publishOverlaySettingsSnapshot() {},
    hasValidOverlayCapture: () => false, setTrackedGameWindowState() {}, invalidateOverlayCapture() {},
  });
  for (const name of ['applyVnGuideScene', 'updateOverlayCaptureStatus']) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0], context);
  }
  context.updateOverlayCaptureStatus({ scene_name: 'Game One', available: false });
  assert.deepEqual(snapshot(settings), first);
  context.updateOverlayCaptureStatus({ scene_name: 'Game Two', available: false });
  assert.deepEqual(snapshot(settings), defaults);
  Object.assign(settings, second);
  scenes.record('vnGuideRoute');
  context.updateOverlayCaptureStatus({ scene_name: 'Game Two', available: false });
  context.updateOverlayCaptureStatus({ scene_name: '', available: false });
  assert.deepEqual(snapshot(settings), second);
  assert.equal(profileReads, 2, 'heartbeats must not poll config.json');
  context.updateOverlayCaptureStatus({ scene_name: 'Game One', available: false });
  assert.deepEqual(snapshot(settings), first);
  assert.deepEqual(configured, [first, defaults, first]);
  assert.equal(saved.length, 3);
  assert.deepEqual(hidden, [[false, 'Game One'], [false, 'Game Two'], [false, 'Game One']]);
});
