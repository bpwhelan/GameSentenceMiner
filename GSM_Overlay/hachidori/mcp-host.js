// Configuration for native MCP clients, over the existing sharing relay.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";
import "./vendor/languages/registry.js";
import { redactSecrets } from "./debug-log.js";
import { SCRIPT_ID } from "./custom-javascript.js";

const mcpObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Nested settings patches preserve siblings (especially credentials); arrays
// replace as a unit, exactly as in Settings. Object.fromEntries also treats
// __proto__ as data, rather than invoking Object.prototype's setter.
export function mergeMcpPatch(current, patch) {
  if (!mcpObject(patch)) return patch;
  return Object.fromEntries([...new Set([...Object.keys(mcpObject(current) ? current : {}), ...Object.keys(patch)])]
    .map(key => [key, Object.hasOwn(patch, key) ? mergeMcpPatch(current?.[key], patch[key]) : current[key]]));
}

// Anki's flat fields mirror its first Template for older readers. A supplied
// Templates array replaces that projection; a flat patch edits the first one.
function syncAnkiTemplate(anki, source, keys) {
  const first = anki.templates?.[0];
  if (Object.hasOwn(source, "templates")) {
    if (mcpObject(first)) for (const key of keys) anki[key] = first[key];
    return;
  }
  for (const key of keys) {
    if (Object.hasOwn(source, key)) first[key] = anki[key];
  }
}

function optionsPatch(options, source, optionsApi) {
  if (!mcpObject(source)) throw new Error("Supply a settings patch object.");
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(optionsApi.DEFAULT_OPTIONS, key)) throw new Error(`Unknown setting: ${key}`);
  }
  // Merge only supplied keys; the ordinary writer validates values and refuses
  // a stale baseRevision.
  const patch = Object.fromEntries(Object.entries(source)
    .map(([key, value]) => [key, mergeMcpPatch(options[key], value)]));
  if (mcpObject(patch.anki)) syncAnkiTemplate(patch.anki, source.anki, optionsApi.ANKI_TEMPLATE_CONFIG_KEYS);
  return patch;
}

function scriptsPatch(scripts, message) {
  const index = scripts.findIndex(script => script.id === message.id);
  if (typeof message.id !== "string" || !message.id) throw new Error("Supply a stable userscript id.");
  if (message.remove === true) {
    if (index < 0) throw new Error("The userscript no longer exists.");
    scripts.splice(index, 1);
    return scripts;
  }
  if (!mcpObject(message.script) || Object.keys(message.script).some(key => !["name", "enabled", "javascript", "css"].includes(key))) {
    throw new Error("Supply userscript name, enabled, javascript and/or css fields.");
  }
  const previous = index < 0 ? { id: message.id, name: "", enabled: true, javascript: "", css: "" } : scripts[index];
  const script = { ...previous, ...message.script };
  if (["name", "javascript", "css"].some(key => Object.hasOwn(message.script, key) && script[key] !== previous[key])) delete script.store;
  if (index < 0) scripts.push(script);
  else scripts[index] = script;
  return scripts;
}

export function createMcpHost({ read, writeOptions, writeSelection, userScripts, themes, version }) {
  const optionsApi = globalThis.HDReaderOptions;
  const { DEFAULT_OPTIONS, GLOBAL_OPTION_KEYS, NUMBER_RANGES, OPTION_REQUIREMENTS, EXPERIMENTAL_FEATURES,
    profiles, activeProfileId, normaliseLanguageSelection, projectOptions, projectDictionaryState } = optionsApi;

  async function scriptStatus() {
    try {
      const scripts = await userScripts();
      return { available: true, registered: scripts.some(script => script.id === SCRIPT_ID),
        reloadRequired: true };
    } catch {
      return { available: false, registered: false, reloadRequired: true,
        instruction: "Enable Allow User Scripts in Chrome's extension details, or Allow user scripts in Hachidori Settings on Firefox. Reload the page after saving JavaScript." };
    }
  }

  return async message => {
    const stored = await read();
    const profileId = message.profileId ?? activeProfileId(stored.options, stored.languageSelection);
    const list = profiles(stored.options);
    if (!list.some(profile => profile.id === profileId)) throw new Error("The selected language profile no longer exists.");
    const options = projectOptions(stored.options, profileId, { masked: false });
    switch (message.type) {
      case "hd_mcp_describe": {
        return redactSecrets({ version, profileId, revision: stored.options?.revision ?? 0,
          activeProfileId: activeProfileId(stored.options, stored.languageSelection),
          selection: normaliseLanguageSelection(stored.languageSelection),
          profiles: list.map(({ id, language, packSettings }) => ({ id, language, packSettings })),
          options, effectiveOptions: projectOptions(stored.options, profileId),
          defaults: DEFAULT_OPTIONS, globalOptionKeys: GLOBAL_OPTION_KEYS,
          choices: Object.fromEntries(Object.entries(optionsApi.ENUMERATED_OPTIONS).map(([key, values]) => [key, [...values]])),
          numberRanges: NUMBER_RANGES, optionRequirements: OPTION_REQUIREMENTS, experimentalFeatures: EXPERIMENTAL_FEATURES,
          languages: globalThis.HDLanguages.codes.map(code => {
            const pack = globalThis.HDLanguages.get(code);
            return { code, name: pack.name, nativeName: pack.nativeName, settings: pack.settings,
              ttsLanguage: pack.host?.ttsLanguage, recommendedDictionaries: pack.host?.recommendedDictionaries ?? [] };
          }),
          dictionaries: projectDictionaryState(stored.dictionaryState, profileId)?.dictionaries ?? [],
          themes: await themes(), userScriptRuntime: await scriptStatus() });
      }
      case "hd_mcp_options_write": {
        const patch = optionsPatch(options, message.options, optionsApi);
        return redactSecrets(await writeOptions({ ...message, type: "hd_options_write", profileId, options: patch }));
      }
      case "hd_mcp_select_profile":
        if (!optionsApi.languagesEnabled(stored.options)) throw new Error("Enable Multiple languages before selecting a lookup language.");
        return writeSelection({ ...message, type: "hd_language_selection_write", activeProfileId: profileId });
      case "hd_mcp_user_script_write": {
        const scripts = scriptsPatch(options.userScripts, message);
        const result = await writeOptions({ ...message, type: "hd_options_write", profileId, options: { userScripts: scripts } });
        return redactSecrets(result);
      }
      default: throw new Error("Unsupported MCP configuration request.");
    }
  };
}
