/*
 * Copyright (C) 2025  Yomitan Authors
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

import {parseHTML} from '../../lib/linkedom.js';
import {DictionaryDatabaseProxy, OffscreenProxy} from '../background/offscreen-proxy.js';
import {RequestBuilder} from '../background/request-builder.js';
import {invokeApiMapHandler} from '../core/api-map.js';
import {EventListenerCollection} from '../core/event-listener-collection.js';
import {ExtensionError} from '../core/extension-error.js';
import {parseJson, readResponseJson} from '../core/json.js';
import {log} from '../core/log.js';
import {toError} from '../core/to-error.js';
import {createFuriganaHtml, createFuriganaPlain} from '../data/anki-note-builder.js';
import {getDynamicTemplates} from '../data/anki-template-util.js';
import {generateAnkiNoteMediaFileName} from '../data/anki-util.js';
import {compareRevisions} from '../dictionary/dictionary-data-util.js';
import {DictionaryWorker} from '../dictionary/dictionary-worker.js';
import {getLanguageSummaries} from '../language/languages.js';
import {AudioDownloader} from '../media/audio-downloader.js';
import {getFileExtensionFromAudioMediaType, getFileExtensionFromImageMediaType} from '../media/media-util.js';
import {getDictionaryEntryMedia} from '../pages/settings/anki-deck-generator-controller.js';
import {AnkiTemplateRenderer} from '../templates/anki-template-renderer.js';

const GSM_CHARACTER_DICTIONARY_TITLE = 'GSM Character Dictionary';
const GSM_DICTIONARY_SETTINGS_SOURCE = 'backend';

/** */
export class YomitanApi {
    /**
     * @param {import('api').ApiMap} apiMap
     * @param {OffscreenProxy?} offscreen
     */
    constructor(apiMap, offscreen) {
        /** @type {?chrome.runtime.Port} */
        this._port = null;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {number} */
        this._timeout = 5000;
        /** @type {number} */
        this._version = 1;
        /** @type {?number} */
        this._remoteVersion = null;
        /** @type {boolean} */
        this._enabled = false;
        /** @type {?Promise<void>} */
        this._setupPortPromise = null;
        /** @type {import('api').ApiMap} */
        this._apiMap = apiMap;
        /** @type {RequestBuilder} */
        this._requestBuilder = new RequestBuilder();
        /** @type {AudioDownloader} */
        this._audioDownloader = new AudioDownloader(this._requestBuilder);
        /** @type {OffscreenProxy?} */
        this._offscreen = offscreen;
    }

    /**
     * @returns {boolean}
     */
    isEnabled() {
        return this._enabled;
    }

    /**
     * @param {boolean} enabled
     */
    async setEnabled(enabled) {
        this._enabled = !!enabled;
        if (!this._enabled && this._port !== null) {
            this._clearPort();
        }
        if (this._enabled) {
            await this.startApiServer();
        }
    }

    /** */
    disconnect() {
        if (this._port !== null) {
            this._clearPort();
        }
    }

    /**
     * @returns {boolean}
     */
    isConnected() {
        return (this._port !== null);
    }

    /**
     * @returns {number}
     */
    getLocalVersion() {
        return this._version;
    }

    /**
     * @param {string} url
     * @returns {Promise<?number>}
     */
    async getRemoteVersion(url) {
        if (this._port === null) {
            await this.startApiServer();
        }
        await this._updateRemoteVersion(url);
        return this._remoteVersion;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async startApiServer() {
        try {
            await this._setupPortWrapper();
            return true;
        } catch (e) {
            log.error(e);
            return false;
        }
    }

    /**
     * Handles a Yomitan API action for the GSM overlay bridge.
     * @param {string} action
     * @param {unknown} body
     * @returns {Promise<{data: unknown, responseStatusCode: number}>}
     */
    async invokeBridgeAction(action, body) {
        if (typeof action !== 'string' || action.length === 0) {
            throw new Error('Invalid Yomitan API action');
        }
        const parsedBody = this._normalizeRequestBody(body);
        return await this._invokeYomitanApiAction(action, parsedBody);
    }

    // Private

    /**
     * @param {unknown} message
     */
    async _onMessage(message) {
        if (typeof message !== 'object' || message === null) { return; }

        if (this._port !== null) {
            const {action, params, body} = /** @type {import('core').SerializableObject} */ (message);
            if (typeof action !== 'string' || typeof params !== 'object' || typeof body !== 'string') {
                this._port.postMessage({action, params, body, data: 'null', responseStatusCode: 400});
                return;
            }

            try {
                const parsedBody = this._normalizeRequestBody(body);
                const {data, responseStatusCode} = await this._invokeYomitanApiAction(action, parsedBody);
                this._port.postMessage({action, params, body, data, responseStatusCode});
            } catch (error) {
                log.error(error);
                this._port.postMessage({action, params, body, data: JSON.stringify(error), responseStatusCode: 500});
            }
        }
    }

    /**
     * @param {unknown} body
     * @returns {object}
     */
    _normalizeRequestBody(body) {
        /** @type {unknown} */
        let parsedBody = body;
        if (typeof body === 'string') {
            parsedBody = body.length > 0 ? parseJson(body) : {};
        } else if (typeof body === 'undefined') {
            parsedBody = {};
        }
        if (typeof parsedBody !== 'object' || parsedBody === null) {
            throw new Error('Invalid request body');
        }
        return parsedBody;
    }

    /**
     * @param {string} action
     * @param {object} parsedBody
     * @returns {Promise<{data: unknown, responseStatusCode: number}>}
     */
    async _invokeYomitanApiAction(action, parsedBody) {
        const optionsFull = await this._invoke('optionsGetFull', void 0);

        let result = null;
        let statusCode = 200;
        switch (action) {
            case 'yomitanVersion': {
                const {version} = chrome.runtime.getManifest();
                result = {version: version};
                break;
            }
            case 'termEntries': {
                /** @type {import('yomitan-api.js').termEntriesInput} */
                // @ts-expect-error - Allow this to error
                const {term} = parsedBody;
                const invokeParams = {
                    text: term,
                    details: {},
                    optionsContext: {index: optionsFull.profileCurrent},
                };
                result = await this._invoke(
                    'termsFind',
                    invokeParams,
                );
                break;
            }
            case 'kanjiEntries': {
                /** @type {import('yomitan-api.js').kanjiEntriesInput} */
                // @ts-expect-error - Allow this to error
                const {character} = parsedBody;
                const invokeParams = {
                    text: character,
                    details: {},
                    optionsContext: {index: optionsFull.profileCurrent},
                };
                result = await this._invoke(
                    'kanjiFind',
                    invokeParams,
                );
                break;
            }
            case 'ankiFields': {
                /** @type {import('yomitan-api.js').ankiFieldsInput} */
                // @ts-expect-error - Allow this to error
                const {text, type, markers, maxEntries, includeMedia} = parsedBody;
                const includeAudioMedia = includeMedia && markers.includes('audio');

                const profileOptions = optionsFull.profiles[optionsFull.profileCurrent].options;

                const ankiTemplate = await this._getAnkiTemplate(profileOptions);
                let dictionaryEntries = await this._getDictionaryEntries(text, type, optionsFull.profileCurrent);
                if (maxEntries > 0) {
                    dictionaryEntries = dictionaryEntries.slice(0, maxEntries);
                }

                // @ts-expect-error - `parseHTML` can return `null` but this input has been validated to not be `null`
                const domlessDocument = parseHTML('').document;
                // @ts-expect-error - `parseHTML` can return `null` but this input has been validated to not be `null`
                const domlessWindow = parseHTML('').window;

                const dictionaryMedia = includeMedia ? await this._fetchDictionaryMedia(dictionaryEntries) : [];
                const audioMedia = includeAudioMedia ? await this._fetchAudio(dictionaryEntries, profileOptions) : [];
                const commonDatas = await this._createCommonDatas(text, dictionaryEntries, dictionaryMedia, audioMedia, profileOptions, domlessDocument);
                const ankiTemplateRenderer = new AnkiTemplateRenderer(domlessDocument, domlessWindow);
                await ankiTemplateRenderer.prepare();
                const templateRenderer = ankiTemplateRenderer.templateRenderer;

                /** @type {Array<Record<string, string>>} */
                const ankiFieldsResults = [];
                for (const commonData of commonDatas) {
                    /** @type {Record<string, string>} */
                    const ankiFieldsResult = {};
                    for (const marker of markers) {
                        const templateResult = templateRenderer.render(ankiTemplate, {marker: marker, commonData: commonData}, 'ankiNote');
                        ankiFieldsResult[marker] = templateResult.result;
                    }
                    ankiFieldsResults.push(ankiFieldsResult);
                }
                result = {
                    fields: ankiFieldsResults,
                    dictionaryMedia: dictionaryMedia,
                    audioMedia: audioMedia,
                };
                break;
            }
            case 'tokenize': {
                /** @type {import('yomitan-api.js').tokenizeInput} */
                // @ts-expect-error - Allow this to error
                const {text, scanLength} = parsedBody;
                if (typeof text !== 'string' && !Array.isArray(text)) {
                    throw new Error('Invalid input for tokenize, expected "text" to be a string or a string array but got ' + typeof text);
                }
                if (typeof scanLength !== 'number') {
                    throw new Error('Invalid input for tokenize, expected "scanLength" to be a number but got ' + typeof scanLength);
                }
                const invokeParams = {
                    text: text,
                    optionsContext: {index: optionsFull.profileCurrent},
                    scanLength: scanLength,
                    useInternalParser: true,
                    useMecabParser: false,
                };
                result = await this._invoke('parseText', invokeParams);
                break;
            }
            case 'ensureGsmCharacterDictionary': {
                const {
                    dictionaryTitle = GSM_CHARACTER_DICTIONARY_TITLE,
                    downloadUrl,
                    indexUrl,
                } = /** @type {{dictionaryTitle?: unknown, downloadUrl?: unknown, indexUrl?: unknown}} */ (parsedBody);
                if (typeof dictionaryTitle !== 'string' || dictionaryTitle.length === 0) {
                    throw new Error('Invalid GSM character dictionary title');
                }
                if (typeof downloadUrl !== 'undefined' && typeof downloadUrl !== 'string') {
                    throw new Error('Invalid GSM character dictionary download URL');
                }
                if (typeof indexUrl !== 'undefined' && typeof indexUrl !== 'string') {
                    throw new Error('Invalid GSM character dictionary index URL');
                }
                result = await this._ensureDictionaryFresh({
                    dictionaryTitle,
                    downloadUrl,
                    indexUrl,
                    profileIndex: optionsFull.profileCurrent,
                });
                break;
            }
            default:
                statusCode = 400;
        }

        return {data: result, responseStatusCode: statusCode};
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @returns {Promise<string>}
     */
    async _getAnkiTemplate(options) {
        let staticTemplates = options.anki.fieldTemplates;
        if (typeof staticTemplates !== 'string') { staticTemplates = await this._invoke('getDefaultAnkiFieldTemplates', void 0); }
        const dictionaryInfo = await this._invoke('getDictionaryInfo', void 0);
        const dynamicTemplates = getDynamicTemplates(options, dictionaryInfo);
        return staticTemplates + '\n' + dynamicTemplates;
    }

    /**
     * @param {string} text
     * @param {import('settings.js').AnkiCardFormatType} type
     * @param {number} profileIndex
     * @returns {Promise<import('dictionary.js').DictionaryEntry[]>}
     */
    async _getDictionaryEntries(text, type, profileIndex) {
        if (type === 'term') {
            const invokeParams = {
                text: text,
                details: {},
                optionsContext: {index: profileIndex},
            };
            return (await this._invoke('termsFind', invokeParams)).dictionaryEntries;
        } else {
            const invokeParams = {
                text: text,
                details: {},
                optionsContext: {index: profileIndex},
            };
            return await this._invoke('kanjiFind', invokeParams);
        }
    }

    /**
     * @param {import('dictionary.js').DictionaryEntry[]} dictionaryEntries
     * @returns {Promise<import('yomitan-api.js').apiDictionaryMediaDetails[]>}
     */
    async _fetchDictionaryMedia(dictionaryEntries) {
        /** @type {import('yomitan-api.js').apiDictionaryMediaDetails[]} */
        const media = [];
        let mediaCount = 0;
        for (const dictionaryEntry of dictionaryEntries) {
            const dictionaryEntryMedias = getDictionaryEntryMedia(dictionaryEntry);
            const mediaRequestTargets = dictionaryEntryMedias.map((x) => { return {path: x.path, dictionary: x.dictionary}; });
            const mediaFilesData = await this._invoke('getMedia', {
                targets: mediaRequestTargets,
            });
            for (const mediaFileData of mediaFilesData) {
                if (media.some((x) => x.dictionary === mediaFileData.dictionary && x.path === mediaFileData.path)) { continue; }
                const timestamp = Date.now();
                const ankiFilename = generateAnkiNoteMediaFileName(`yomitan_dictionary_media_${mediaCount}`, getFileExtensionFromImageMediaType(mediaFileData.mediaType) ?? '', timestamp);
                media.push({
                    dictionary: mediaFileData.dictionary,
                    path: mediaFileData.path,
                    mediaType: mediaFileData.mediaType,
                    width: mediaFileData.width,
                    height: mediaFileData.height,
                    content: mediaFileData.content,
                    ankiFilename: ankiFilename,
                });
                mediaCount += 1;
            }
        }
        return media;
    }

    /**
     *
     * @param {import('dictionary.js').DictionaryEntry[]} dictionaryEntries
     * @param {import('settings').ProfileOptions} options
     * @returns {Promise<import('yomitan-api.js').apiAudioMediaDetails[]>}
     */
    async _fetchAudio(dictionaryEntries, options) {
        const audioDatas = [];
        const idleTimeout = (Number.isFinite(options.anki.downloadTimeout) && options.anki.downloadTimeout > 0 ? options.anki.downloadTimeout : null);
        const languageSummary = getLanguageSummaries().find(({iso}) => iso === options.general.language);
        if (!languageSummary) { return []; }
        for (const dictionaryEntry of dictionaryEntries) {
            if (dictionaryEntry.type === 'kanji') { continue; }
            const headword = dictionaryEntry.headwords[0]; // Only one headword is accepted for Anki card creation
            try {
                const audioData = await this._audioDownloader.downloadTermAudio(options.audio.sources, null, headword.term, headword.reading, idleTimeout, languageSummary, options.audio.enableDefaultAudioSources);
                const timestamp = Date.now();
                const mediaType = audioData.contentType ?? '';
                let extension = mediaType !== null ? getFileExtensionFromAudioMediaType(mediaType) : null;
                if (extension === null) { extension = '.mp3'; }
                const ankiFilename = generateAnkiNoteMediaFileName('yomitan_audio', extension, timestamp);
                audioDatas.push({
                    term: headword.term,
                    reading: headword.reading,
                    mediaType: mediaType,
                    content: audioData.data,
                    ankiFilename: ankiFilename,
                });
            } catch (e) {
                log.log('Yomitan API failed to download audio ' + toError(e).message);
            }
        }
        return audioDatas;
    }

    /**
     * @param {string} text
     * @param {import('dictionary.js').DictionaryEntry[]} dictionaryEntries
     * @param {import('yomitan-api.js').apiDictionaryMediaDetails[]} dictionaryMediaDetails
     * @param {import('yomitan-api.js').apiAudioMediaDetails[]} audioMediaDetails
     * @param {import('settings').ProfileOptions} options
     * @param {Document} domlessDocument
     * @returns {Promise<import('anki-note-builder.js').CommonData[]>}
     */
    async _createCommonDatas(text, dictionaryEntries, dictionaryMediaDetails, audioMediaDetails, options, domlessDocument) {
        /** @type {import('anki-note-builder.js').CommonData[]} */
        const commonDatas = [];
        for (const dictionaryEntry of dictionaryEntries) {
            /** @type {import('anki-templates.js').DictionaryMedia} */
            const dictionaryMedia = {};
            const dictionaryEntryMedias = getDictionaryEntryMedia(dictionaryEntry);
            if (dictionaryMediaDetails.length > 0) {
                for (const dictionaryEntryMedia of dictionaryEntryMedias) {
                    const mediaFile = dictionaryMediaDetails.find((x) => x.dictionary === dictionaryEntryMedia.dictionary && x.path === dictionaryEntryMedia.path);
                    if (!mediaFile) {
                        log.error('Failed to find media for commonDatas generation');
                        continue;
                    }
                    if (!Object.hasOwn(dictionaryMedia, dictionaryEntryMedia.dictionary)) {
                        dictionaryMedia[dictionaryEntryMedia.dictionary] = {};
                    }
                    dictionaryMedia[dictionaryEntryMedia.dictionary][dictionaryEntryMedia.path] = {value: mediaFile.ankiFilename};
                }
            }

            let audioMediaFile = '';
            /** @type {import('api').ParseTextLine[]} */
            let furiganaData = [];
            if (dictionaryEntry.type === 'term') {
                audioMediaFile = audioMediaDetails.find((x) => x.term === dictionaryEntry.headwords[0].term && x.reading === dictionaryEntry.headwords[0].reading)?.ankiFilename ?? '';

                furiganaData = [[{
                    text: dictionaryEntry.headwords[0].term,
                    reading: dictionaryEntry.headwords[0].reading,
                }]];
            }
            const furiganaReadingMode = options.parsing.readingMode === 'hiragana' || options.parsing.readingMode === 'katakana' ? options.parsing.readingMode : null;

            commonDatas.push({
                dictionaryEntry: dictionaryEntry,
                resultOutputMode: 'group',
                cardFormat: {
                    type: 'term',
                    name: '',
                    deck: '',
                    model: '',
                    fields: {},
                    icon: 'big-circle',
                },
                glossaryLayoutMode: 'default',
                compactTags: false,
                context: {
                    url: '',
                    documentTitle: '',
                    query: text,
                    fullQuery: text,
                    sentence: {
                        text: '',
                        offset: 0,
                    },
                },
                media: {
                    audio: audioMediaFile.length > 0 ? {value: audioMediaFile} : void 0,
                    textFurigana: [{
                        text: text,
                        readingMode: furiganaReadingMode,
                        detailsHtml: {
                            value: createFuriganaHtml(furiganaData, furiganaReadingMode, null),
                        },
                        detailsPlain: {
                            value: createFuriganaPlain(furiganaData, furiganaReadingMode, null),
                        },
                    }],
                    dictionaryMedia: dictionaryMedia,
                },
                dictionaryStylesMap: await this._getDictionaryStylesMapDomless(options, domlessDocument),
            });
        }
        return commonDatas;
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @param {Document} domlessDocument
     * @returns {Promise<Map<string, string>>}
     */
    async _getDictionaryStylesMapDomless(options, domlessDocument) {
        const styleMap = new Map();
        for (const dictionary of options.dictionaries) {
            const {name, styles} = dictionary;
            if (typeof styles === 'string') {
                // newlines and returns do not get converted into json well, are not required in css, and cause invalid css if not parsed for by the api consumer, just do the work for them
                const sanitizedCSS = (await this._sanitizeCSSOffscreen(options, styles, domlessDocument)).replaceAll(/(\r|\n)/g, ' ');
                styleMap.set(name, sanitizedCSS);
            }
        }
        return styleMap;
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @param {string} css
     * @param {Document} domlessDocument
     * @returns {Promise<string>}
     */
    async _sanitizeCSSOffscreen(options, css, domlessDocument) {
        if (css.length === 0) { return ''; }
        try {
            if (!this._offscreen) {
                throw new Error('Offscreen page not available');
            }
            const sanitizedCSS = this._offscreen ? await this._offscreen.sendMessagePromise({action: 'sanitizeCSSOffscreen', params: {css}}) : '';
            if (sanitizedCSS.length === 0 && css.length > 0) {
                throw new Error('CSS parsing failed');
            }
            return sanitizedCSS;
        } catch (e) {
            log.log('Offscreen CSS sanitizer failed: ' + toError(e).message);
        }

        try {
            const style = domlessDocument.createElement('style');
            // eslint-disable-next-line no-unsanitized/property
            style.innerHTML = css;
            domlessDocument.appendChild(style);
            const styleSheet = style.sheet;
            if (!styleSheet) {
                throw new Error('CSS parsing failed');
            }
            return [...styleSheet.cssRules].map((rule) => rule.cssText || '').join('\n');
        } catch (e) {
            log.log('CSSOM CSS sanitizer failed: ' + toError(e).message);
        }

        if (options.general.yomitanApiAllowCssSanitizationBypass) {
            log.log('Failed to sanitize CSS. Sanitization bypass is enabled, passing through CSS without sanitization: ' + css.replaceAll(/(\r|\n)/g, ' '));
            return css;
        }

        log.log('Failed to sanitize CSS: ' + css.replaceAll(/(\r|\n)/g, ' '));
        return '';
    }

    /**
     * @param {{dictionaryTitle: string, downloadUrl?: string, indexUrl?: string, profileIndex: number}} details
     * @returns {Promise<{status: string, dictionaryTitle: string, revision?: string, latestRevision?: string, warnings?: string[]}>}
     */
    async _ensureDictionaryFresh({dictionaryTitle, downloadUrl, indexUrl, profileIndex}) {
        const installedDictionaries = await this._invoke('getDictionaryInfo', void 0);
        const installedDictionary = installedDictionaries.find(({title}) => title === dictionaryTitle) ?? null;

        let resolvedDownloadUrl = this._normalizeOptionalUrl(downloadUrl) ?? installedDictionary?.downloadUrl ?? null;
        let resolvedIndexUrl = this._normalizeOptionalUrl(indexUrl) ?? installedDictionary?.indexUrl ?? null;
        let latestRevision = installedDictionary?.revision;

        if (resolvedIndexUrl !== null) {
            const latestIndex = await this._fetchDictionaryIndex(resolvedIndexUrl);
            latestRevision = latestIndex.revision;
            resolvedDownloadUrl = latestIndex.downloadUrl ?? resolvedDownloadUrl;

            if (
                installedDictionary !== null &&
                typeof installedDictionary.revision === 'string' &&
                !compareRevisions(installedDictionary.revision, latestRevision)
            ) {
                return {
                    status: 'current',
                    dictionaryTitle,
                    revision: installedDictionary.revision,
                    latestRevision,
                };
            }
        } else if (installedDictionary !== null) {
            return {
                status: 'installed',
                dictionaryTitle,
                revision: installedDictionary.revision,
            };
        }

        if (resolvedDownloadUrl === null) {
            throw new Error(`No download URL available for ${dictionaryTitle}`);
        }

        const archiveContent = await this._downloadDictionaryArchive(resolvedDownloadUrl);
        const optionsFull = await this._invoke('optionsGetFull', void 0);
        const profilesDictionarySettings = (
            installedDictionary !== null ?
            this._getProfilesDictionarySettings(optionsFull, dictionaryTitle) :
            null
        );

        if (installedDictionary !== null) {
            await this._deleteDictionary(dictionaryTitle);
            await this._invoke('triggerDatabaseUpdated', {type: 'dictionary', cause: 'delete'});
        }

        const importDetails = {
            prefixWildcardsSupported: optionsFull.global.database.prefixWildcardsSupported,
            yomitanVersion: chrome.runtime.getManifest().version,
        };
        const {result, errors} = await this._importDictionary(archiveContent, importDetails);
        if (!result) {
            const message = errors.map((error) => toError(error).message).join('; ');
            throw new Error(message.length > 0 ? message : `Failed to import ${dictionaryTitle}`);
        }

        await this._addOrUpdateDictionarySettings(result, profilesDictionarySettings, profileIndex);
        await this._invoke('triggerDatabaseUpdated', {type: 'dictionary', cause: 'import'});

        return {
            status: installedDictionary !== null ? 'updated' : 'installed',
            dictionaryTitle,
            revision: result.revision,
            latestRevision,
            warnings: errors.map((error) => toError(error).message),
        };
    }

    /**
     * @param {string} dictionaryTitle
     * @returns {Promise<void>}
     */
    async _deleteDictionary(dictionaryTitle) {
        if (this._offscreen !== null) {
            await new DictionaryDatabaseProxy(this._offscreen).deleteDictionary(dictionaryTitle);
            return;
        }
        await new DictionaryWorker().deleteDictionary(dictionaryTitle, null);
    }

    /**
     * @param {ArrayBuffer} archiveContent
     * @param {import('dictionary-importer').ImportDetails} importDetails
     * @returns {Promise<import('dictionary-importer').ImportResult>}
     */
    async _importDictionary(archiveContent, importDetails) {
        if (this._offscreen !== null) {
            return await new DictionaryDatabaseProxy(this._offscreen).importDictionary(archiveContent, importDetails);
        }
        return await new DictionaryWorker().importDictionary(archiveContent, importDetails, null);
    }

    /**
     * @param {string} url
     * @returns {Promise<{revision: string, downloadUrl: string|null}>}
     */
    async _fetchDictionaryIndex(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Dictionary index request failed (${response.status})`);
        }
        const index = await readResponseJson(response);
        if (typeof index !== 'object' || index === null) {
            throw new Error('Invalid dictionary index');
        }

        const {revision, downloadUrl} = /** @type {{revision?: unknown, downloadUrl?: unknown}} */ (index);
        if (typeof revision !== 'string' || revision.length === 0) {
            throw new Error('Dictionary index is missing a revision');
        }

        return {
            revision,
            downloadUrl: this._normalizeOptionalUrl(downloadUrl),
        };
    }

    /**
     * @param {string} url
     * @returns {Promise<ArrayBuffer>}
     */
    async _downloadDictionaryArchive(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Dictionary download failed (${response.status})`);
        }
        return await response.arrayBuffer();
    }

    /**
     * @param {import('api').ApiReturn<'optionsGetFull'>} optionsFull
     * @param {string} dictionaryTitle
     * @returns {Record<string, {index: number, alias: string, name: string, enabled: boolean, allowSecondarySearches: boolean, definitionsCollapsible: string, partsOfSpeechFilter: boolean, useDeinflections: boolean, styles?: string}>}
     */
    _getProfilesDictionarySettings(optionsFull, dictionaryTitle) {
        /** @type {Record<string, {index: number, alias: string, name: string, enabled: boolean, allowSecondarySearches: boolean, definitionsCollapsible: string, partsOfSpeechFilter: boolean, useDeinflections: boolean, styles?: string}>} */
        const profilesDictionarySettings = {};
        const {profiles} = optionsFull;
        for (const profile of profiles) {
            const dictionaries = profile.options.dictionaries;
            for (let i = 0; i < dictionaries.length; ++i) {
                if (dictionaries[i].name === dictionaryTitle) {
                    profilesDictionarySettings[profile.id] = {...dictionaries[i], index: i};
                    break;
                }
            }
        }
        return profilesDictionarySettings;
    }

    /**
     * @param {import('dictionary-importer').Summary} summary
     * @param {ReturnType<YomitanApi['_getProfilesDictionarySettings']>|null} profilesDictionarySettings
     * @param {number} profileIndex
     * @returns {Promise<void>}
     */
    async _addOrUpdateDictionarySettings(summary, profilesDictionarySettings, profileIndex) {
        const {title, sequenced, styles = ''} = summary;
        const optionsFull = await this._invoke('optionsGetFull', void 0);
        /** @type {import('settings-modifications').ScopedModification[]} */
        const targets = [];

        for (let i = 0; i < optionsFull.profiles.length; ++i) {
            const {options, id: profileId} = optionsFull.profiles[i];
            const path = `profiles[${i}].options.dictionaries`;
            const existingSettings = profilesDictionarySettings?.[profileId];

            if (typeof existingSettings === 'undefined') {
                targets.push({
                    action: 'set',
                    path,
                    scope: 'global',
                    optionsContext: null,
                    value: [
                        ...options.dictionaries,
                        this._createDefaultDictionarySettings(title, profileIndex === i, styles),
                    ],
                });
            } else {
                const {index, alias, name, ...currentSettings} = existingSettings;
                const dictionaries = [...options.dictionaries];
                dictionaries[index] = {
                    ...currentSettings,
                    styles,
                    name: title,
                    alias: alias === name ? title : alias,
                };
                targets.push({
                    action: 'set',
                    path,
                    scope: 'global',
                    optionsContext: null,
                    value: dictionaries,
                });
            }

            if (sequenced && options.general.mainDictionary === '') {
                targets.push({
                    action: 'set',
                    path: `profiles[${i}].options.general.mainDictionary`,
                    scope: 'global',
                    optionsContext: null,
                    value: title,
                });
            }
        }

        if (targets.length === 0) { return; }
        const results = await this._invoke('modifySettings', {targets, source: GSM_DICTIONARY_SETTINGS_SOURCE});
        for (const result of results) {
            if (typeof result?.error !== 'undefined') {
                throw ExtensionError.deserialize(result.error);
            }
        }
    }

    /**
     * @param {string} name
     * @param {boolean} enabled
     * @param {string} styles
     * @returns {import('settings').DictionaryOptions}
     */
    _createDefaultDictionarySettings(name, enabled, styles) {
        return {
            name,
            alias: name,
            enabled,
            allowSecondarySearches: false,
            definitionsCollapsible: 'not-collapsible',
            partsOfSpeechFilter: true,
            useDeinflections: true,
            styles,
        };
    }

    /**
     * @param {unknown} value
     * @returns {string|null}
     */
    _normalizeOptionalUrl(value) {
        return (typeof value === 'string' && value.length > 0 ? value : null);
    }

    /**
     * @param {string} url
     */
    async _updateRemoteVersion(url) {
        if (!url) {
            throw new Error('Missing Yomitan API URL');
        }
        try {
            const response = await fetch(url + '/serverVersion', {
                method: 'POST',
            });
            /** @type {import('yomitan-api.js').remoteVersionResponse} */
            const {version} = await readResponseJson(response);

            this._remoteVersion = version;
        } catch (e) {
            log.error(e);
            throw new Error('Failed to fetch. Try again in a moment. The nativemessaging component can take a few seconds to start.');
        }
    }

    /**
     * @returns {void}
     */
    _onDisconnect() {
        if (this._port === null) { return; }
        const e = chrome.runtime.lastError;
        const error = new Error(e ? e.message : 'Yomitan Api disconnected');
        log.error(error);
        this._clearPort();
    }

    /**
     * @returns {Promise<void>}
     */
    async _setupPortWrapper() {
        if (!this._enabled) {
            throw new Error('Yomitan Api not enabled');
        }
        if (this._setupPortPromise === null) {
            this._setupPortPromise = this._setupPort();
        }
        try {
            await this._setupPortPromise;
        } catch (e) {
            throw toError(e);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _setupPort() {
        const port = chrome.runtime.connectNative('yomitan_api');
        this._eventListeners.addListener(port.onMessage, this._onMessage.bind(this));
        this._eventListeners.addListener(port.onDisconnect, this._onDisconnect.bind(this));
        this._port = port;
    }

    /**
     * @returns {void}
     */
    _clearPort() {
        if (this._port !== null) {
            this._port.disconnect();
            this._port = null;
        }
        this._eventListeners.removeAllEventListeners();
        this._setupPortPromise = null;
    }

    /**
     * @template {import('api').ApiNames} TAction
     * @template {import('api').ApiParams<TAction>} TParams
     * @param {TAction} action
     * @param {TParams} params
     * @returns {Promise<import('api').ApiReturn<TAction>>}
     */
    _invoke(action, params) {
        return new Promise((resolve, reject) => {
            try {
                invokeApiMapHandler(this._apiMap, action, params, [{}], (response) => {
                    if (response !== null && typeof response === 'object') {
                        const {error} = /** @type {import('core').UnknownObject} */ (response);
                        if (typeof error !== 'undefined') {
                            reject(ExtensionError.deserialize(/** @type {import('core').SerializedError} */(error)));
                        } else {
                            const {result} = /** @type {import('core').UnknownObject} */ (response);
                            resolve(/** @type {import('api').ApiReturn<TAction>} */(result));
                        }
                    } else {
                        const message = response === null ? 'Unexpected null response. You may need to refresh the page.' : `Unexpected response of type ${typeof response}. You may need to refresh the page.`;
                        reject(new Error(`${message} (${JSON.stringify(action)})`));
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }
}
