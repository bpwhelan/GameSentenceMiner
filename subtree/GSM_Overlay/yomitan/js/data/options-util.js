/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {fetchJson, fetchText} from '../core/fetch-utilities.js';
import {parseJson} from '../core/json.js';
import {isObjectNotArray} from '../core/object-utilities.js';
import {escapeRegExp} from '../core/utilities.js';
import {TemplatePatcher} from '../templates/template-patcher.js';
import {JsonSchema} from './json-schema.js';

// Some type safety rules are disabled for this file since it deals with upgrading an older format
// of the options object to a newer format. SafeAny is used for much of this, since every single
// legacy format does not contain type definitions.
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

export class OptionsUtil {
    constructor() {
        /** @type {?TemplatePatcher} */
        this._templatePatcher = null;
        /** @type {?JsonSchema} */
        this._optionsSchema = null;
    }

    /** */
    async prepare() {
        /** @type {import('ext/json-schema').Schema} */
        const schema = await fetchJson('/data/schemas/options-schema.json');
        this._optionsSchema = new JsonSchema(schema);
    }

    /**
     * @param {unknown} optionsInput
     * @param {?number} [targetVersion]
     * @returns {Promise<import('settings').Options>}
     */
    async update(optionsInput, targetVersion = null) {
        // Invalid options
        let options = /** @type {{[key: string]: unknown}} */ (
            typeof optionsInput === 'object' && optionsInput !== null && !Array.isArray(optionsInput) ?
            optionsInput :
            {}
        );

        // Check for legacy options
        let defaultProfileOptions = {};
        if (!Array.isArray(options.profiles)) {
            defaultProfileOptions = options;
            options = {};
        }

        // Ensure profiles is an array
        if (!Array.isArray(options.profiles)) {
            options.profiles = [];
        }

        // Remove invalid profiles
        const profiles = /** @type {unknown[]} */ (options.profiles);
        for (let i = profiles.length - 1; i >= 0; --i) {
            if (!isObjectNotArray(profiles[i])) {
                profiles.splice(i, 1);
            }
        }

        // Require at least one profile
        if (profiles.length === 0) {
            profiles.push({
                name: 'Default',
                options: defaultProfileOptions,
                conditionGroups: [],
            });
        }

        // Ensure profileCurrent is valid
        const profileCurrent = options.profileCurrent;
        if (!(
            typeof profileCurrent === 'number' &&
            Number.isFinite(profileCurrent) &&
            Math.floor(profileCurrent) === profileCurrent &&
            profileCurrent >= 0 &&
            profileCurrent < profiles.length
        )) {
            options.profileCurrent = 0;
        }

        // Version
        if (typeof options.version !== 'number') {
            options.version = 0;
        }

        // Generic updates
        options = await this._applyUpdates(options, this._getVersionUpdates(targetVersion));

        // Validation
        return /** @type {import('settings').Options} */ (/** @type {JsonSchema} */ (this._optionsSchema).getValidValueOrDefault(options));
    }

    /**
     * @returns {Promise<import('settings').Options>}
     */
    async load() {
        let options;
        try {
            const optionsStr = await new Promise((resolve, reject) => {
                chrome.storage.local.get(['options'], (store) => {
                    const error = chrome.runtime.lastError;
                    if (error) {
                        reject(new Error(error.message));
                    } else {
                        resolve(store.options);
                    }
                });
            });
            if (typeof optionsStr !== 'string') {
                throw new Error('Invalid value for options');
            }
            options = parseJson(optionsStr);
        } catch (e) {
            // NOP
        }

        if (typeof options !== 'undefined') {
            options = await this.update(options);
            await this.save(options);
        } else {
            options = this.getDefault();
        }

        return options;
    }

    /**
     * @param {import('settings').Options} options
     * @returns {Promise<void>}
     */
    save(options) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.set({options: JSON.stringify(options)}, () => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * @returns {import('settings').Options}
     */
    getDefault() {
        const optionsVersion = this._getVersionUpdates(null).length;
        const options = /** @type {import('settings').Options} */ (/** @type {JsonSchema} */ (this._optionsSchema).getValidValueOrDefault());
        options.version = optionsVersion;
        return options;
    }

    /**
     * @param {import('settings').Options} options
     * @returns {import('settings').Options}
     */
    createValidatingProxy(options) {
        return /** @type {import('settings').Options} */ (/** @type {JsonSchema} */ (this._optionsSchema).createProxy(options));
    }

    /**
     * @param {import('settings').Options} options
     */
    validate(options) {
        /** @type {JsonSchema} */ (this._optionsSchema).validate(options);
    }

    // Legacy profile updating

    /**
     * @returns {(?import('options-util').LegacyUpdateFunction)[]}
     */
    _legacyProfileUpdateGetUpdates() {
        return [
            null,
            null,
            null,
            null,
            (options) => {
                options.general.audioSource = options.general.audioPlayback ? 'jpod101' : 'disabled';
            },
            (options) => {
                options.general.showGuide = false;
            },
            (options) => {
                options.scanning.modifier = options.scanning.requireShift ? 'shift' : 'none';
            },
            (options) => {
                options.general.resultOutputMode = options.general.groupResults ? 'group' : 'split';
                options.anki.fieldTemplates = null;
            },
            (options) => {
                if (this._getStringHashCode(options.anki.fieldTemplates) === 1285806040) {
                    options.anki.fieldTemplates = null;
                }
            },
            (options) => {
                if (this._getStringHashCode(options.anki.fieldTemplates) === -250091611) {
                    options.anki.fieldTemplates = null;
                }
            },
            (options) => {
                const oldAudioSource = options.general.audioSource;
                const disabled = oldAudioSource === 'disabled';
                options.audio.enabled = !disabled;
                options.audio.volume = options.general.audioVolume;
                options.audio.autoPlay = options.general.autoPlayAudio;
                options.audio.sources = [disabled ? 'jpod101' : oldAudioSource];

                delete options.general.audioSource;
                delete options.general.audioVolume;
                delete options.general.autoPlayAudio;
            },
            (options) => {
                // Version 12 changes:
                //  The preferred default value of options.anki.fieldTemplates has been changed to null.
                if (this._getStringHashCode(options.anki.fieldTemplates) === 1444379824) {
                    options.anki.fieldTemplates = null;
                }
            },
            (options) => {
                // Version 13 changes:
                //  Default anki field tempaltes updated to include {document-title}.
                let fieldTemplates = options.anki.fieldTemplates;
                if (typeof fieldTemplates === 'string') {
                    fieldTemplates += '\n\n{{#*inline "document-title"}}\n    {{~context.document.title~}}\n{{/inline}}';
                    options.anki.fieldTemplates = fieldTemplates;
                }
            },
            (options) => {
                // Version 14 changes:
                //  Changed template for Anki audio and tags.
                let fieldTemplates = options.anki.fieldTemplates;
                if (typeof fieldTemplates !== 'string') { return; }

                const replacements = [
                    [
                        '{{#*inline "audio"}}{{/inline}}',
                        '{{#*inline "audio"}}\n    {{~#if definition.audioFileName~}}\n        [sound:{{definition.audioFileName}}]\n    {{~/if~}}\n{{/inline}}',
                    ],
                    [
                        '{{#*inline "tags"}}\n    {{~#each definition.definitionTags}}{{name}}{{#unless @last}}, {{/unless}}{{/each~}}\n{{/inline}}',
                        '{{#*inline "tags"}}\n    {{~#mergeTags definition group merge}}{{this}}{{/mergeTags~}}\n{{/inline}}',
                    ],
                ];

                for (const [pattern, replacement] of replacements) {
                    let replaced = false;
                    fieldTemplates = fieldTemplates.replace(new RegExp(escapeRegExp(pattern), 'g'), () => {
                        replaced = true;
                        return replacement;
                    });

                    if (!replaced) {
                        fieldTemplates += '\n\n' + replacement;
                    }
                }

                options.anki.fieldTemplates = fieldTemplates;
            },
        ];
    }

    /**
     * @returns {import('options-util').LegacyOptions}
     */
    _legacyProfileUpdateGetDefaults() {
        return {
            general: {
                enable: true,
                enableClipboardPopups: false,
                resultOutputMode: 'group',
                debugInfo: false,
                maxResults: 32,
                fontFamily: '',
                fontSize: 14,
                lineHeight: '1.5',
                showAdvanced: false,
                popupDisplayMode: 'default',
                popupWidth: 400,
                popupHeight: 250,
                popupHorizontalOffset: 0,
                popupVerticalOffset: 10,
                popupHorizontalOffset2: 10,
                popupVerticalOffset2: 0,
                popupHorizontalTextPosition: 'below',
                popupVerticalTextPosition: 'before',
                popupScalingFactor: 1,
                popupScaleRelativeToPageZoom: false,
                popupScaleRelativeToVisualViewport: true,
                showGuide: true,
                compactTags: false,
                compactGlossaries: false,
                mainDictionary: '',
                popupTheme: 'default',
                popupOuterTheme: 'default',
                customPopupCss: '',
                customPopupOuterCss: '',
                enableWanakana: true,
                enableClipboardMonitor: false,
                showPitchAccentDownstepNotation: true,
                showPitchAccentPositionNotation: true,
                showPitchAccentGraph: false,
                showIframePopupsInRootFrame: false,
                useSecurePopupFrameUrl: true,
                usePopupShadowDom: true,
            },

            audio: {
                enabled: true,
                sources: ['jpod101'],
                volume: 100,
                autoPlay: false,
                customSourceUrl: '',
                textToSpeechVoice: '',
            },

            scanning: {
                middleMouse: true,
                touchInputEnabled: true,
                selectText: true,
                alphanumeric: true,
                autoHideResults: false,
                delay: 20,
                length: 10,
                modifier: 'shift',
                deepDomScan: false,
                popupNestingMaxDepth: 0,
                enablePopupSearch: false,
                enableOnPopupExpressions: false,
                enableOnSearchPage: true,
                enableSearchTags: false,
                layoutAwareScan: false,
                scanAltText: true,
            },

            translation: {
                convertHalfWidthCharacters: 'false',
                convertNumericCharacters: 'false',
                convertAlphabeticCharacters: 'false',
                convertHiraganaToKatakana: 'false',
                convertKatakanaToHiragana: 'variant',
                collapseEmphaticSequences: 'false',
            },

            dictionaries: {},

            parsing: {
                enableScanningParser: true,
                enableMecabParser: false,
                selectedParser: null,
                termSpacing: true,
                readingMode: 'hiragana',
            },

            anki: {
                enable: false,
                server: 'http://127.0.0.1:8765',
                tags: ['yomitan'],
                sentenceExt: 200,
                screenshot: {format: 'png', quality: 92},
                terms: {deck: '', model: '', fields: {}},
                kanji: {deck: '', model: '', fields: {}},
                duplicateScope: 'collection',
                fieldTemplates: null,
            },
        };
    }

    /**
     * @param {import('options-util').IntermediateOptions} options
     * @returns {import('options-util').IntermediateOptions}
     */
    _legacyProfileUpdateAssignDefaults(options) {
        const defaults = this._legacyProfileUpdateGetDefaults();

        /**
         * @param {import('options-util').IntermediateOptions} target
         * @param {import('core').UnknownObject} source
         */
        const combine = (target, source) => {
            for (const key in source) {
                if (!Object.prototype.hasOwnProperty.call(target, key)) {
                    target[key] = source[key];
                }
            }
        };

        combine(options, defaults);
        combine(options.general, defaults.general);
        combine(options.scanning, defaults.scanning);
        combine(options.anki, defaults.anki);
        combine(options.anki.terms, defaults.anki.terms);
        combine(options.anki.kanji, defaults.anki.kanji);

        return options;
    }

    /**
     * @param {import('options-util').IntermediateOptions} options
     * @returns {import('options-util').IntermediateOptions}
     */
    _legacyProfileUpdateUpdateVersion(options) {
        const updates = this._legacyProfileUpdateGetUpdates();
        this._legacyProfileUpdateAssignDefaults(options);

        const targetVersion = updates.length;
        const currentVersion = options.version;

        if (typeof currentVersion === 'number' && Number.isFinite(currentVersion)) {
            for (let i = Math.max(0, Math.floor(currentVersion)); i < targetVersion; ++i) {
                const update = updates[i];
                if (update !== null) {
                    update(options);
                }
            }
        }

        options.version = targetVersion;
        return options;
    }

    // Private

    /**
     * @param {import('options-util').IntermediateOptions} options
     * @param {string} modificationsUrl
     */
    async _applyAnkiFieldTemplatesPatch(options, modificationsUrl) {
        let patch = null;
        for (const {options: profileOptions} of options.profiles) {
            const fieldTemplates = profileOptions.anki.fieldTemplates;
            if (fieldTemplates === null) { continue; }

            if (patch === null) {
                const content = await fetchText(modificationsUrl);
                if (this._templatePatcher === null) {
                    this._templatePatcher = new TemplatePatcher();
                }
                patch = this._templatePatcher.parsePatch(content);
            }

            profileOptions.anki.fieldTemplates = /** @type {TemplatePatcher} */ (this._templatePatcher).applyPatch(fieldTemplates, patch);
        }
    }

    /**
     * @param {string} string
     * @returns {number}
     */
    _getStringHashCode(string) {
        let hashCode = 0;

        if (typeof string !== 'string') { return hashCode; }

        for (let i = 0, charCode = string.charCodeAt(i); i < string.length; charCode = string.charCodeAt(++i)) {
            hashCode = ((hashCode << 5) - hashCode) + charCode;
            hashCode |= 0;
        }

        return hashCode;
    }

    /**
     * @param {import('options-util').IntermediateOptions} options
     * @param {import('options-util').UpdateFunction[]} updates
     * @returns {Promise<import('settings').Options>}
     */
    async _applyUpdates(options, updates) {
        const targetVersion = updates.length;
        let currentVersion = options.version;

        if (typeof currentVersion !== 'number' || !Number.isFinite(currentVersion)) {
            currentVersion = 0;
        }

        for (let i = Math.max(0, Math.floor(currentVersion)); i < targetVersion; ++i) {
            const update = updates[i];
            const result = update.call(this, options);
            if (result instanceof Promise) { await result; }
        }

        options.version = targetVersion;
        return options;
    }

    /**
     * @param {?number} targetVersion
     * @returns {import('options-util').UpdateFunction[]}
     */
    _getVersionUpdates(targetVersion) {
        /* eslint-disable @typescript-eslint/unbound-method */
        const result = [
            this._updateVersion1,
            this._updateVersion2,
            this._updateVersion3,
            this._updateVersion4,
            this._updateVersion5,
            this._updateVersion6,
            this._updateVersion7,
            this._updateVersion8,
            this._updateVersion9,
            this._updateVersion10,
            this._updateVersion11,
            this._updateVersion12,
            this._updateVersion13,
            this._updateVersion14,
            this._updateVersion15,
            this._updateVersion16,
            this._updateVersion17,
            this._updateVersion18,
            this._updateVersion19,
            this._updateVersion20,
            this._updateVersion21,
            this._updateVersion22,
            this._updateVersion23,
            this._updateVersion24,
            this._updateVersion25,
            this._updateVersion26,
            this._updateVersion27,
            this._updateVersion28,
            this._updateVersion29,
            this._updateVersion30,
            this._updateVersion31,
            this._updateVersion32,
            this._updateVersion33,
            this._updateVersion34,
            this._updateVersion35,
            this._updateVersion36,
            this._updateVersion37,
            this._updateVersion38,
            this._updateVersion39,
            this._updateVersion40,
            this._updateVersion41,
            this._updateVersion42,
            this._updateVersion43,
            this._updateVersion44,
            this._updateVersion45,
            this._updateVersion46,
            this._updateVersion47,
            this._updateVersion48,
            this._updateVersion49,
            this._updateVersion50,
            this._updateVersion51,
            this._updateVersion52,
            this._updateVersion53,
            this._updateVersion54,
            this._updateVersion55,
            this._updateVersion56,
            this._updateVersion57,
            this._updateVersion58,
            this._updateVersion59,
            this._updateVersion60,
            this._updateVersion61,
            this._updateVersion62,
            this._updateVersion63,
            this._updateVersion64,
            this._updateVersion65,
            this._updateVersion66,
            this._updateVersion67,
            this._updateVersion68,
            this._updateVersion69,
            this._updateVersion70,
            this._updateVersion71,
            this._updateVersion72,
            this._updateVersion73,
        ];
        /* eslint-enable @typescript-eslint/unbound-method */
        if (typeof targetVersion === 'number' && targetVersion < result.length) {
            result.splice(targetVersion);
        }
        return result;
    }

    /**
     * - Added options.global.database.prefixWildcardsSupported = false.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion1(options) {
        options.global = {
            database: {
                prefixWildcardsSupported: false,
            },
        };
    }

    /**
     * - Legacy profile update process moved into this upgrade function.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion2(options) {
        for (const profile of options.profiles) {
            if (!Array.isArray(profile.conditionGroups)) {
                profile.conditionGroups = [];
            }
            profile.options = this._legacyProfileUpdateUpdateVersion(profile.options);
        }
    }

    /**
     * - Pitch accent Anki field templates added.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion3(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v2.handlebars');
    }

    /**
     * - Options conditions converted to string representations.
     * - Added usePopupWindow.
     * - Updated handlebars templates to include "clipboard-image" definition.
     * - Updated handlebars templates to include "clipboard-text" definition.
     * - Added hideDelay.
     * - Added inputs to profileOptions.scanning.
     * - Added pointerEventsEnabled to profileOptions.scanning.
     * - Added preventMiddleMouse to profileOptions.scanning.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion4(options) {
        for (const {conditionGroups} of options.profiles) {
            for (const {conditions} of conditionGroups) {
                for (const condition of conditions) {
                    const value = condition.value;
                    condition.value = (
                        Array.isArray(value) ?
                        value.join(', ') :
                        `${value}`
                    );
                }
            }
        }
        const createInputDefaultOptions = () => ({
            showAdvanced: false,
            searchTerms: true,
            searchKanji: true,
            scanOnTouchMove: false,
            scanOnPenHover: false,
            scanOnPenPress: true,
            scanOnPenRelease: false,
            preventTouchScrolling: true,
            minimumTouchTime: 0,
        });
        for (const {options: profileOptions} of options.profiles) {
            profileOptions.general.usePopupWindow = false;
            profileOptions.scanning.hideDelay = 0;
            profileOptions.scanning.pointerEventsEnabled = false;
            profileOptions.scanning.preventMiddleMouse = {
                onTextHover: false,
                onWebPages: false,
                onPopupPages: false,
                onSearchPages: false,
                onSearchQuery: false,
            };
            profileOptions.scanning.preventBackForward = {
                onTextHover: false,
                onWebPages: false,
                onPopupPages: false,
                onSearchPages: false,
                onSearchQuery: false,
            };

            const {modifier, middleMouse} = profileOptions.scanning;
            delete profileOptions.scanning.modifier;
            delete profileOptions.scanning.middleMouse;
            const scanningInputs = [];
            let modifierInput = '';
            switch (modifier) {
                case 'alt':
                case 'ctrl':
                case 'shift':
                case 'meta':
                    modifierInput = modifier;
                    break;
                case 'none':
                    modifierInput = '';
                    break;
            }
            scanningInputs.push({
                include: modifierInput,
                exclude: 'mouse0',
                types: {mouse: true, touch: false, pen: false},
                options: createInputDefaultOptions(),
            });
            if (middleMouse) {
                scanningInputs.push({
                    include: 'mouse2',
                    exclude: '',
                    types: {mouse: true, touch: false, pen: false},
                    options: createInputDefaultOptions(),
                });
            }
            scanningInputs.push({
                include: '',
                exclude: '',
                types: {mouse: false, touch: true, pen: true},
                options: createInputDefaultOptions(),
            });
            profileOptions.scanning.inputs = scanningInputs;
        }
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v4.handlebars');
    }

    /**
     * - Removed legacy version number from profile options.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion5(options) {
        for (const profile of options.profiles) {
            delete profile.options.version;
        }
    }

    /**
     * - Updated handlebars templates to include "conjugation" definition.
     * - Added global option showPopupPreview.
     * - Added global option useSettingsV2.
     * - Added anki.checkForDuplicates.
     * - Added general.glossaryLayoutMode; removed general.compactGlossaries.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion6(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v6.handlebars');
        options.global.showPopupPreview = false;
        options.global.useSettingsV2 = false;
        for (const profile of options.profiles) {
            profile.options.anki.checkForDuplicates = true;
            profile.options.general.glossaryLayoutMode = (profile.options.general.compactGlossaries ? 'compact' : 'default');
            delete profile.options.general.compactGlossaries;
            const fieldTemplates = profile.options.anki.fieldTemplates;
            if (typeof fieldTemplates === 'string') {
                profile.options.anki.fieldTemplates = this._updateVersion6AnkiTemplatesCompactTags(fieldTemplates);
            }
        }
    }

    /**
     * @param {string} templates
     * @returns {string}
     */
    _updateVersion6AnkiTemplatesCompactTags(templates) {
        const rawPattern1 = '{{~#if definitionTags~}}<i>({{#each definitionTags}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})</i> {{/if~}}';
        const pattern1 = new RegExp(`((\r?\n)?[ \t]*)${escapeRegExp(rawPattern1)}`, 'g');
        const replacement1 = (
        // eslint-disable-next-line @stylistic/indent
`{{~#scope~}}
    {{~#set "any" false}}{{/set~}}
    {{~#if definitionTags~}}{{#each definitionTags~}}
        {{~#if (op "||" (op "!" ../data.compactTags) (op "!" redundant))~}}
            {{~#if (get "any")}}, {{else}}<i>({{/if~}}
            {{name}}
            {{~#set "any" true}}{{/set~}}
        {{~/if~}}
    {{~/each~}}
    {{~#if (get "any")}})</i> {{/if~}}
    {{~/if~}}
{{~/scope~}}`
        );
        const simpleNewline = /\n/g;
        templates = templates.replace(pattern1, (g0, space) => (space + replacement1.replace(simpleNewline, space)));
        templates = templates.replace(/\bcompactGlossaries=((?:\.*\/)*)compactGlossaries\b/g, (g0, g1) => `${g0} data=${g1}.`);
        return templates;
    }

    /**
     * - Added general.maximumClipboardSearchLength.
     * - Added general.popupCurrentIndicatorMode.
     * - Added general.popupActionBarVisibility.
     * - Added general.popupActionBarLocation.
     * - Removed global option showPopupPreview.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion7(options) {
        delete options.global.showPopupPreview;
        for (const profile of options.profiles) {
            profile.options.general.maximumClipboardSearchLength = 1000;
            profile.options.general.popupCurrentIndicatorMode = 'triangle';
            profile.options.general.popupActionBarVisibility = 'auto';
            profile.options.general.popupActionBarLocation = 'right';
        }
    }

    /**
     * - Added translation.textReplacements.
     * - Moved anki.sentenceExt to sentenceParsing.scanExtent.
     * - Added sentenceParsing.enableTerminationCharacters.
     * - Added sentenceParsing.terminationCharacters.
     * - Changed general.popupActionBarLocation.
     * - Added inputs.hotkeys.
     * - Added anki.suspendNewCards.
     * - Added popupWindow.
     * - Updated handlebars templates to include "stroke-count" definition.
     * - Updated global.useSettingsV2 to be true (opt-out).
     * - Added audio.customSourceType.
     * - Moved general.enableClipboardPopups => clipboard.enableBackgroundMonitor.
     * - Moved general.enableClipboardMonitor => clipboard.enableSearchPageMonitor. Forced value to false due to a bug which caused its value to not be read.
     * - Moved general.maximumClipboardSearchLength => clipboard.maximumSearchLength.
     * - Added clipboard.autoSearchContent.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion8(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v8.handlebars');
        options.global.useSettingsV2 = true;
        for (const profile of options.profiles) {
            profile.options.translation.textReplacements = {
                searchOriginal: true,
                groups: [],
            };
            profile.options.sentenceParsing = {
                scanExtent: profile.options.anki.sentenceExt,
                enableTerminationCharacters: true,
                terminationCharacters: [
                    {enabled: true, character1: '「', character2: '」', includeCharacterAtStart: false, includeCharacterAtEnd: false},
                    {enabled: true, character1: '『', character2: '』', includeCharacterAtStart: false, includeCharacterAtEnd: false},
                    {enabled: true, character1: '"', character2: '"', includeCharacterAtStart: false, includeCharacterAtEnd: false},
                    {enabled: true, character1: '\'', character2: '\'', includeCharacterAtStart: false, includeCharacterAtEnd: false},
                    {enabled: true, character1: '.', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                    {enabled: true, character1: '!', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                    {enabled: true, character1: '?', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                    {enabled: true, character1: '．', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                    {enabled: true, character1: '。', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                    {enabled: true, character1: '！', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                    {enabled: true, character1: '？', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                    {enabled: true, character1: '…', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: true},
                ],
            };
            delete profile.options.anki.sentenceExt;
            profile.options.general.popupActionBarLocation = 'top';
            /* eslint-disable @stylistic/no-multi-spaces */
            profile.options.inputs = {
                hotkeys: [
                    {action: 'close',             key: 'Escape',    modifiers: [],       scopes: ['popup'], enabled: true},
                    {action: 'focusSearchBox',    key: 'Escape',    modifiers: [],       scopes: ['search'], enabled: true},
                    {action: 'previousEntry3',    key: 'PageUp',    modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'nextEntry3',        key: 'PageDown',  modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'lastEntry',         key: 'End',       modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'firstEntry',        key: 'Home',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'previousEntry',     key: 'ArrowUp',   modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'nextEntry',         key: 'ArrowDown', modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'historyBackward',   key: 'KeyB',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'historyForward',    key: 'KeyF',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'addNoteKanji',      key: 'KeyK',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'addNoteTermKanji',  key: 'KeyE',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'addNoteTermKana',   key: 'KeyR',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'playAudio',         key: 'KeyP',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'viewNote',          key: 'KeyV',      modifiers: ['alt'],  scopes: ['popup', 'search'], enabled: true},
                    {action: 'copyHostSelection', key: 'KeyC',      modifiers: ['ctrl'], scopes: ['popup'], enabled: true},
                ],
            };
            /* eslint-enable @stylistic/no-multi-spaces */
            profile.options.anki.suspendNewCards = false;
            profile.options.popupWindow = {
                width: profile.options.general.popupWidth,
                height: profile.options.general.popupHeight,
                left: 0,
                top: 0,
                useLeft: false,
                useTop: false,
                windowType: 'popup',
                windowState: 'normal',
            };
            profile.options.audio.customSourceType = 'audio';
            profile.options.clipboard = {
                enableBackgroundMonitor: profile.options.general.enableClipboardPopups,
                enableSearchPageMonitor: false,
                autoSearchContent: true,
                maximumSearchLength: profile.options.general.maximumClipboardSearchLength,
            };
            delete profile.options.general.enableClipboardPopups;
            delete profile.options.general.enableClipboardMonitor;
            delete profile.options.general.maximumClipboardSearchLength;
        }
    }

    /**
     * - Added general.frequencyDisplayMode.
     * - Added general.termDisplayMode.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion9(options) {
        for (const profile of options.profiles) {
            profile.options.general.frequencyDisplayMode = 'split-tags-grouped';
            profile.options.general.termDisplayMode = 'ruby';
        }
    }

    /**
     * - Removed global option useSettingsV2.
     * - Added part-of-speech field template.
     * - Added an argument to hotkey inputs.
     * - Added definitionsCollapsible to dictionary options.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion10(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v10.handlebars');
        delete options.global.useSettingsV2;
        for (const profile of options.profiles) {
            for (const dictionaryOptions of Object.values(profile.options.dictionaries)) {
                dictionaryOptions.definitionsCollapsible = 'not-collapsible';
            }
            for (const hotkey of profile.options.inputs.hotkeys) {
                switch (hotkey.action) {
                    case 'previousEntry':
                        hotkey.argument = '1';
                        break;
                    case 'previousEntry3':
                        hotkey.action = 'previousEntry';
                        hotkey.argument = '3';
                        break;
                    case 'nextEntry':
                        hotkey.argument = '1';
                        break;
                    case 'nextEntry3':
                        hotkey.action = 'nextEntry';
                        hotkey.argument = '3';
                        break;
                    default:
                        hotkey.argument = '';
                        break;
                }
            }
        }
    }

    /**
     * - Changed dictionaries to an array.
     * - Changed audio.customSourceUrl's {expression} marker to {term}.
     * - Added anki.displayTags.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion11(options) {
        const customSourceUrlPattern = /\{expression\}/g;
        for (const profile of options.profiles) {
            const dictionariesNew = [];
            for (const [name, {priority, enabled, allowSecondarySearches, definitionsCollapsible}] of Object.entries(profile.options.dictionaries)) {
                dictionariesNew.push({name, priority, enabled, allowSecondarySearches, definitionsCollapsible});
            }
            profile.options.dictionaries = dictionariesNew;

            let {customSourceUrl} = profile.options.audio;
            if (typeof customSourceUrl === 'string') {
                customSourceUrl = customSourceUrl.replace(customSourceUrlPattern, '{term}');
            }
            profile.options.audio.customSourceUrl = customSourceUrl;

            profile.options.anki.displayTags = 'never';
        }
    }

    /**
     * - Changed sentenceParsing.enableTerminationCharacters to sentenceParsing.terminationCharacterMode.
     * - Added {search-query} field marker.
     * - Updated audio.sources[] to change 'custom' into 'custom-json'.
     * - Removed audio.customSourceType.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion12(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v12.handlebars');
        for (const profile of options.profiles) {
            const {sentenceParsing, audio} = profile.options;

            sentenceParsing.terminationCharacterMode = sentenceParsing.enableTerminationCharacters ? 'custom' : 'newlines';
            delete sentenceParsing.enableTerminationCharacters;

            const {sources, customSourceUrl, customSourceType, textToSpeechVoice} = audio;
            audio.sources = /** @type {string[]} */ (sources).map((type) => {
                switch (type) {
                    case 'text-to-speech':
                    case 'text-to-speech-reading':
                        return {type, url: '', voice: textToSpeechVoice};
                    case 'custom':
                        return {type: (customSourceType === 'json' ? 'custom-json' : 'custom'), url: customSourceUrl, voice: ''};
                    default:
                        return {type, url: '', voice: ''};
                }
            });
            delete audio.customSourceType;
            delete audio.customSourceUrl;
            delete audio.textToSpeechVoice;
        }
    }

    /**
     * - Handlebars templates updated to use formatGlossary.
     * - Handlebars templates updated to use new media format.
     * - Added {selection-text} field marker.
     * - Added {sentence-furigana} field marker.
     * - Added anki.duplicateScopeCheckAllModels.
     * - Updated pronunciation templates.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion13(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v13.handlebars');
        for (const profile of options.profiles) {
            profile.options.anki.duplicateScopeCheckAllModels = false;
        }
    }

    /**
     * - Added accessibility options.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion14(options) {
        for (const profile of options.profiles) {
            profile.options.accessibility = {
                forceGoogleDocsHtmlRendering: false,
            };
        }
    }

    /**
     * - Added general.sortFrequencyDictionary.
     * - Added general.sortFrequencyDictionaryOrder.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion15(options) {
        for (const profile of options.profiles) {
            profile.options.general.sortFrequencyDictionary = null;
            profile.options.general.sortFrequencyDictionaryOrder = 'descending';
        }
    }

    /**
     * - Added scanning.matchTypePrefix.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion16(options) {
        for (const profile of options.profiles) {
            profile.options.scanning.matchTypePrefix = false;
        }
    }

    /**
     * - Added vertical sentence punctuation to terminationCharacters.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion17(options) {
        const additions = ['︒', '︕', '︖', '︙'];
        for (const profile of options.profiles) {
            /** @type {import('settings').SentenceParsingTerminationCharacterOption[]} */
            const terminationCharacters = profile.options.sentenceParsing.terminationCharacters;
            const newAdditions = [];
            for (const character of additions) {
                if (!terminationCharacters.some((value) => (value.character1 === character && value.character2 === null))) {
                    newAdditions.push(character);
                }
            }
            for (const character of newAdditions) {
                terminationCharacters.push({
                    enabled: true,
                    character1: character,
                    character2: null,
                    includeCharacterAtStart: false,
                    includeCharacterAtEnd: true,
                });
            }
        }
    }

    /**
     * - general.popupTheme's 'default' value changed to 'light'
     * - general.popupOuterTheme's 'default' value changed to 'light'
     * - general.popupOuterTheme's 'auto' value changed to 'site'
     * - Added scanning.hidePopupOnCursorExit.
     * - Added scanning.hidePopupOnCursorExitDelay.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion18(options) {
        for (const profile of options.profiles) {
            const {general} = profile.options;
            if (general.popupTheme === 'default') {
                general.popupTheme = 'light';
            }
            switch (general.popupOuterTheme) {
                case 'default': general.popupOuterTheme = 'light'; break;
                case 'auto': general.popupOuterTheme = 'site'; break;
            }
            profile.options.scanning.hidePopupOnCursorExit = false;
            profile.options.scanning.hidePopupOnCursorExitDelay = profile.options.scanning.hideDelay;
        }
    }

    /**
     * - Added anki.noteGuiMode.
     * - Added anki.apiKey.
     * - Renamed scanning.inputs[].options.scanOnPenPress to scanOnPenMove.
     * - Renamed scanning.inputs[].options.scanOnPenRelease to scanOnPenReleaseHover.
     * - Added scanning.inputs[].options.scanOnTouchPress.
     * - Added scanning.inputs[].options.scanOnTouchRelease.
     * - Added scanning.inputs[].options.scanOnPenPress.
     * - Added scanning.inputs[].options.scanOnPenRelease.
     * - Added scanning.inputs[].options.preventPenScrolling.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion19(options) {
        for (const profile of options.profiles) {
            profile.options.anki.noteGuiMode = 'browse';
            profile.options.anki.apiKey = '';
            for (const input of profile.options.scanning.inputs) {
                input.options.scanOnPenMove = input.options.scanOnPenPress;
                input.options.scanOnPenReleaseHover = input.options.scanOnPenRelease;
                input.options.scanOnTouchPress = true;
                input.options.scanOnTouchRelease = false;
                input.options.scanOnPenPress = input.options.scanOnPenMove;
                input.options.scanOnPenRelease = false;
                input.options.preventPenScrolling = input.options.preventTouchScrolling;
            }
        }
    }

    /**
     * - Added anki.downloadTimeout.
     * - Added scanning.normalizeCssZoom.
     * - Fixed general.popupTheme invalid default.
     * - Fixed general.popupOuterTheme invalid default.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion20(options) {
        for (const profile of options.profiles) {
            profile.options.anki.downloadTimeout = 0;
            profile.options.scanning.normalizeCssZoom = true;
            const {general} = profile.options;
            if (general.popupTheme === 'default') {
                general.popupTheme = 'light';
            }
            if (general.popupOuterTheme === 'default') {
                general.popupOuterTheme = 'light';
            }
        }
    }

    /**
     * - Converted Handlebars templates to new format.
     * - Assigned flag to show users a warning about template changes.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion21(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v21.handlebars');

        let customTemplates = false;
        for (const {options: profileOptions} of options.profiles) {
            if (profileOptions.anki.fieldTemplates !== null) {
                customTemplates = true;
            }
        }

        if (customTemplates && isObjectNotArray(chrome.storage)) {
            void chrome.storage.session.set({needsCustomTemplatesWarning: true});
            await this._createTab(chrome.runtime.getURL('/welcome.html'));
            void chrome.storage.session.set({openedWelcomePage: true});
        }
    }

    /**
     * - Added translation.searchResolution.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion22(options) {
        for (const {options: profileOptions} of options.profiles) {
            profileOptions.translation.searchResolution = 'letter';
        }
    }

    /**
     * - Added dictionaries[].partsOfSpeechFilter.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion23(options) {
        for (const {options: profileOptions} of options.profiles) {
            if (Array.isArray(profileOptions.dictionaries)) {
                for (const dictionary of profileOptions.dictionaries) {
                    dictionary.partsOfSpeechFilter = true;
                }
            }
        }
    }

    /**
     * - Added dictionaries[].useDeinflections.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion24(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v24.handlebars');

        for (const {options: profileOptions} of options.profiles) {
            if (Array.isArray(profileOptions.dictionaries)) {
                for (const dictionary of profileOptions.dictionaries) {
                    dictionary.useDeinflections = true;
                }
            }
        }
    }

    /**
     * - Change 'viewNote' action to 'viewNotes'.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion25(options) {
        for (const profile of options.profiles) {
            if ('inputs' in profile.options && 'hotkeys' in profile.options.inputs) {
                for (const hotkey of profile.options.inputs.hotkeys) {
                    if (hotkey.action === 'viewNote') {
                        hotkey.action = 'viewNotes';
                    }
                }
            }
        }
    }

    /**
     * - Added general.language.
     * - Modularized text preprocessors.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion26(options) {
        const textPreprocessors = [
            'convertHalfWidthCharacters',
            'convertNumericCharacters',
            'convertAlphabeticCharacters',
            'convertHiraganaToKatakana',
            'convertKatakanaToHiragana',
            'collapseEmphaticSequences',
        ];

        for (const {options: profileOptions} of options.profiles) {
            profileOptions.general.language = 'ja';

            for (const preprocessor of textPreprocessors) {
                delete profileOptions.translation[preprocessor];
            }
        }
    }

    /**
     * - Updated handlebars.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion27(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v27.handlebars');
    }

    /**
     *  - Removed whitespace in URL handlebars template.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion28(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v28.handlebars');
    }

    /**
     *  - Added new handlebar for different pitch accent graph style.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion29(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v29.handlebars');
    }

    /**
     *  - Added scanning.inputs[].options.scanOnTouchTap.
     *  - Set touch settings to be more sensible.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion30(options) {
        for (const profile of options.profiles) {
            for (const input of profile.options.scanning.inputs) {
                input.options.scanOnTouchTap = true;
                input.options.scanOnTouchPress = false;
                input.options.scanOnTouchRelease = false;
            }
        }
    }

    /**
     *  - Added anki.duplicateBehavior
     *  @type {import('options-util').UpdateFunction}
     */
    _updateVersion31(options) {
        for (const {options: profileOptions} of options.profiles) {
            profileOptions.anki.duplicateBehavior = 'new';
        }
    }

    /**
     *  - Added profilePrevious and profileNext to hotkeys.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion32(options) {
        for (const profile of options.profiles) {
            profile.options.inputs.hotkeys.push(
                {action: 'profilePrevious', key: 'Minus', modifiers: ['alt'], scopes: ['popup', 'search'], enabled: true},
                {action: 'profileNext', key: 'Equal', modifiers: ['alt'], scopes: ['popup', 'search'], enabled: true},
            );
        }
    }

    /**
     * - Updated handlebars to fix escaping when using `definition.cloze` or text-based `getMedia`.
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion33(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v33.handlebars');
    }

    /**
     *  - Added dynamic handlebars for single dictionaries.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion34(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v34.handlebars');
    }

    /**
     *  - Added dynamic handlebars for first dictionary entry only.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion35(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v35.handlebars');
    }

    /**
     *  - Added handlebars for onyomi reading in hiragana.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion36(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v36.handlebars');
    }

    /**
     *  - Removed `No pitch accent data` return from pitch handlebars when no data is found
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion37(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v37.handlebars');
    }

    /**
     *  - Updated `conjugation` handlebars for new inflection chain format.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion38(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v38.handlebars');
    }

    /**
     *  - Add new setting enableContextMenuScanSelected
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion39(options) {
        for (const profile of options.profiles) {
            profile.options.general.enableContextMenuScanSelected = true;
        }
    }

    /**
     *  - Added support for web hotkey scope to profilePrevious and profileNext
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion40(options) {
        for (const profile of options.profiles) {
            for (const hotkey of profile.options.inputs.hotkeys) {
                if (hotkey.action === 'profilePrevious' || hotkey.action === 'profileNext') {
                    hotkey.scopes = ['popup', 'search', 'web'];
                }
            }
        }
    }

    /**
     *  - Updated `glossary` handlebars to support dictionary css.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion41(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v41.handlebars');
    }

    /**
     * - Added scanning.scanAltText
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion42(options) {
        for (const profile of options.profiles) {
            profile.options.scanning.scanAltText = true;
        }
    }

    /**
     * - Added option for sticky search header.
     * @type {import('options-util').UpdateFunction}
     */
    _updateVersion43(options) {
        for (const profile of options.profiles) {
            profile.options.general.stickySearchHeader = false;
        }
    }

    /**
     * - Added general.fontFamily
     * - Added general.fontSize
     * - Added general.lineHeight
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion44(options) {
        for (const profile of options.profiles) {
            profile.options.general.fontFamily = 'sans-serif';
            profile.options.general.fontSize = 14;
            profile.options.general.lineHeight = '1.5';
        }
    }

    /**
     * - Renamed `selection-text` to `popup-selection-text`
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion45(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v45.handlebars');
        const oldMarkerRegex = new RegExp('{selection-text}', 'g');
        const newMarker = '{popup-selection-text}';
        for (const profile of options.profiles) {
            const termsFields = profile.options.anki.terms.fields;
            for (const key of Object.keys(termsFields)) {
                termsFields[key] = termsFields[key].replace(oldMarkerRegex, newMarker);
            }
            const kanjiFields = profile.options.anki.kanji.fields;
            for (const key of Object.keys(kanjiFields)) {
                kanjiFields[key] = kanjiFields[key].replace(oldMarkerRegex, newMarker);
            }
        }
    }

    /**
     * - Set default font to empty
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion46(options) {
        for (const profile of options.profiles) {
            if (profile.options.general.fontFamily === 'sans-serif') {
                profile.options.general.fontFamily = '';
            }
        }
    }

    /**
     * - Added scanning.scanWithoutMousemove
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion47(options) {
        for (const profile of options.profiles) {
            profile.options.scanning.scanWithoutMousemove = true;
        }
    }

    /**
     * - Added general.showDebug
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion48(options) {
        for (const profile of options.profiles) {
            profile.options.general.showDebug = false;
        }
    }

    /**
     * - Added dictionary alias
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion49(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v49.handlebars');
        for (const {options: profileOptions} of options.profiles) {
            if (Array.isArray(profileOptions.dictionaries)) {
                for (const dictionary of profileOptions.dictionaries) {
                    dictionary.alias = dictionary.name;
                }
            }
        }
    }

    /**
     * - Generalized jpod101-alternate to language-pod-101
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion50(options) {
        for (const profile of options.profiles) {
            for (const source of profile.options.audio.sources) {
                if (source.type === 'jpod101-alternate') {
                    source.type = 'language-pod-101';
                }
            }
        }
    }

    /**
     * - Add scanning.scanResolution
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion51(options) {
        for (const profile of options.profiles) {
            profile.options.scanning.scanResolution = 'character';
        }
    }

    /**
     * - Remove scanning.scanAltText
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion52(options) {
        for (const profile of options.profiles) {
            delete profile.options.scanning.scanAltText;
        }
    }

    /**
     * - Added profile id
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion53(options) {
        for (let i = 0; i < options.profiles.length; i++) {
            options.profiles[i].id = `profile-${i}`;
        }
    }

    /**
     * - Renamed anki.displayTags to anki.displayTagsAndFlags
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion54(options) {
        for (const profile of options.profiles) {
            profile.options.anki.displayTagsAndFlags = profile.options.anki.displayTags;
            delete profile.options.anki.displayTags;
        }
    }

    /**
     * - Remove scanning.touchInputEnabled
     * - Remove scanning.pointerEventsEnabled
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion55(options) {
        for (const profile of options.profiles) {
            delete profile.options.scanning.touchInputEnabled;
            delete profile.options.scanning.pointerEventsEnabled;
        }
    }

    /**
     * - Sorted dictionaries by priority
     * - Removed priority from dictionaries
     * @type {import('options-util').UpdateFunction}
     */
    async _updateVersion56(options) {
        for (const {options: profileOptions} of options.profiles) {
            if (Array.isArray(profileOptions.dictionaries)) {
                profileOptions.dictionaries.sort((/** @type {{ priority: number; }} */ a, /** @type {{ priority: number; }} */ b) => {
                    return b.priority - a.priority;
                });
                for (const dictionary of profileOptions.dictionaries) {
                    delete dictionary.priority;
                }
            }
        }
    }

    /**
     *  - Added scanning.inputs[].options.minimumTouchTime.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion57(options) {
        for (const profile of options.profiles) {
            for (const input of profile.options.scanning.inputs) {
                input.options.minimumTouchTime = 0;
            }
        }
    }

    /**
     *  - Added audio.options.playFallbackSound
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion58(options) {
        for (const profile of options.profiles) {
            profile.options.audio.playFallbackSound = true;
        }
    }

    /**
     *  - Added overwriteMode to anki.fields
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion59(options) {
        for (const profile of options.profiles) {
            for (const type of ['terms', 'kanji']) {
                const fields = profile.options.anki[type].fields;
                for (const [field, value] of Object.entries(fields)) {
                    fields[field] = {value, overwriteMode: 'coalesce'};
                }
            }
        }
    }

    /**
     *  - Replaced audio.playFallbackSound with audio.fallbackSoundType
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion60(options) {
        for (const profile of options.profiles) {
            profile.options.audio.fallbackSoundType = profile.options.audio.playFallbackSound ? 'click' : 'none';
            delete profile.options.audio.playFallbackSound;
        }
    }

    /**
     *  - Added sentence-furigana-plain handlebar
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion61(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v61.handlebars');
    }

    /**
     *  - Added options.general.averageFrequency
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion62(options) {
        for (const profile of options.profiles) {
            profile.options.general.averageFrequency = false;
        }
    }

    /**
     *  - Added selectable tags to phonetic transcriptions handlebar
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion63(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v63.handlebars');
    }

    /**
     *  - Added multiple anki card formats
     *  - Updated expression template to remove modeTermKana
     *  - Updated hotkeys to use generic note actions
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion64(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v64.handlebars');

        for (const profile of options.profiles) {
            const oldTerms = profile.options.anki.terms;

            const updatedCardFormats = [{
                name: 'Expression',
                icon: 'big-circle',
                deck: oldTerms.deck,
                model: oldTerms.model,
                fields: oldTerms.fields,
                type: 'term',
            }];

            if (Object.values(oldTerms.fields).some((field) => field.value.includes('{expression}'))) {
                updatedCardFormats.push({
                    name: 'Reading',
                    icon: 'small-circle',
                    deck: oldTerms.deck,
                    model: oldTerms.model,
                    fields: Object.fromEntries(
                        Object.entries(oldTerms.fields).map(([key, field]) => [
                            key,
                            {...field, value: field.value.replace(/{expression}/g, '{reading}')},
                        ]),
                    ),
                    type: 'term',
                });
            }

            const language = profile.options.general.language;
            const logographLanguages = ['ja', 'zh', 'yue'];
            if (logographLanguages.includes(language)) {
                const oldKanji = profile.options.anki.kanji;
                const kanjiNote = {
                    name: language === 'ja' ? 'Kanji' : 'Hanzi',
                    icon: 'big-circle',
                    deck: oldKanji.deck,
                    model: oldKanji.model,
                    fields: oldKanji.fields,
                    type: 'kanji',
                };
                updatedCardFormats.push(kanjiNote);
            }

            profile.options.anki.cardFormats = [...updatedCardFormats];

            delete profile.options.anki.terms;
            delete profile.options.anki.kanji;

            if (!profile.options.inputs || !profile.options.inputs.hotkeys) {
                continue;
            }

            for (const hotkey of profile.options.inputs.hotkeys) {
                if (!('argument' in hotkey)) {
                    hotkey.argument = '';
                }
                switch (hotkey.action) {
                    case 'addNoteTermKanji':
                        hotkey.action = 'addNote';
                        hotkey.argument = '0';
                        break;
                    case 'addNoteTermKana':
                        hotkey.action = 'addNote';
                        hotkey.argument = `${Math.min(1, updatedCardFormats.length - 1)}`;
                        break;
                    case 'addNoteKanji':
                        hotkey.action = 'addNote';
                        hotkey.argument = `${updatedCardFormats.length - 1}`;
                        break;
                    case 'viewNotes':
                        hotkey.action = 'viewNotes';
                        hotkey.argument = '0';
                        break;
                }
            }
        }
    }

    /**
     *  - Added general.enableYomitanApi
     *  - Added general.yomitanApiServer
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion65(options) {
        for (const profile of options.profiles) {
            profile.options.general.enableYomitanApi = false;
            profile.options.general.yomitanApiServer = 'http://127.0.0.1:8766';
        }
    }

    /**
     *  - Added glossary-plain handlebars
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion66(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v66.handlebars');
    }

    /**
     * - Added dynamic handlebars for single frequency dictionaries.
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion67(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v67.handlebars');
    }

    /**
     *  - Changed pitch-accent-item param name
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion68(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v68.handlebars');
    }

    /**
     *  - Change default Yomitan API port to 19633
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion69(options) {
        for (const profile of options.profiles) {
            profile.options.general.yomitanApiServer = 'http://127.0.0.1:19633';
        }
    }

    /**
     *  - Added audio.enableDefaultAudioSources
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion70(options) {
        for (const profile of options.profiles) {
            profile.options.audio.enableDefaultAudioSources = true;
        }
    }

    /**
     *  - Added global.dataTransmissionConsentShown
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion71(options) {
        options.global.dataTransmissionConsentShown = false;
    }

    /**
     *  - Always put dict glosses in a list for the `glossary` handlebar (and brief and no-dictionary)
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion72(options) {
        await this._applyAnkiFieldTemplatesPatch(options, '/data/templates/anki-field-templates-upgrade-v71.handlebars');
    }

    /**
     *  - Added anki.targetTags
     *  @type {import('options-util').UpdateFunction}
     */
    async _updateVersion73(options) {
        for (const profile of options.profiles) {
            profile.options.anki.targetTags = [];
        }
    }

    /**
     * @param {string} url
     * @returns {Promise<chrome.tabs.Tab>}
     */
    _createTab(url) {
        return new Promise((resolve, reject) => {
            chrome.tabs.create({url}, (tab) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(tab);
                }
            });
        });
    }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment */
/* eslint-enable @typescript-eslint/no-unsafe-argument */
