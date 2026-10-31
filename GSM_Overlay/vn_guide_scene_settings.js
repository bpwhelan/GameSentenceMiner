const VN_GUIDE_SCENE_SETTING_KEYS = Object.freeze(['vnGuideEnabled', 'vnGuideUrl', 'vnGuideRoute']);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const setEntry = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

class GuideSceneSettings {
  constructor(settings, defaults) {
    this.settings = settings;
    this.defaults = this.snapshot(defaults);
    this.scene = null;
    this.created = !isObject(settings.vnGuideSceneSettings?.scenes);
    if (this.created) {
      const legacyProfiles = {};
      // Retain each old profile's selection until its first scene is observed.
      // Consuming it once prevents unrelated new games from inheriting a guide.
      if (settings.overlaySettingsProfilesEnabled === true) {
        for (const [name, profile] of Object.entries(settings.overlayProfileSettings || {})) {
          if (isObject(profile)) setEntry(legacyProfiles, name, this.snapshot(profile));
        }
        setEntry(legacyProfiles, settings.overlayActiveProfileName || 'Default', this.snapshot(settings));
      } else setEntry(legacyProfiles, '*', this.snapshot(settings));
      settings.vnGuideSceneSettings = { scenes: {}, legacyProfiles };
    }
    this.store = settings.vnGuideSceneSettings;
    if (!isObject(this.store.legacyProfiles)) this.store.legacyProfiles = {};
  }

  snapshot(settings) {
    return {
      vnGuideEnabled: settings.vnGuideEnabled === true,
      vnGuideUrl: typeof settings.vnGuideUrl === 'string' ? settings.vnGuideUrl : '',
      vnGuideRoute: typeof settings.vnGuideRoute === 'string' ? settings.vnGuideRoute : '',
    };
  }

  select(scene, profileName) {
    if (typeof scene !== 'string' || !scene.trim() || scene === this.scene) return false;
    const legacyKey = Object.hasOwn(this.store.legacyProfiles, profileName) ? profileName : '*';
    const saved = this.store.unassigned
      || (Object.hasOwn(this.store.scenes, scene) ? this.store.scenes[scene] : null)
      || (Object.hasOwn(this.store.legacyProfiles, legacyKey) ? this.store.legacyProfiles[legacyKey] : null)
      || this.defaults;
    delete this.store.unassigned;
    delete this.store.legacyProfiles[legacyKey];
    this.scene = scene;
    const selection = this.snapshot(saved);
    setEntry(this.store.scenes, scene, selection);
    Object.assign(this.settings, selection);
    return true;
  }

  record(key) {
    if (!VN_GUIDE_SCENE_SETTING_KEYS.includes(key)) return;
    const selection = this.snapshot(this.settings);
    if (this.scene === null) this.store.unassigned = selection;
    else setEntry(this.store.scenes, this.scene, selection);
  }
}

module.exports = { GuideSceneSettings, VN_GUIDE_SCENE_SETTING_KEYS };
