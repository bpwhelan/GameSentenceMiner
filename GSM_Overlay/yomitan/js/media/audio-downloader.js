/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2017-2022  Yomichan Authors
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

import {RequestBuilder} from '../background/request-builder.js';
import {ExtensionError} from '../core/extension-error.js';
import {readResponseJson} from '../core/json.js';
import {arrayBufferToBase64} from '../data/array-buffer-util.js';
import {JsonSchema} from '../data/json-schema.js';
import {NativeSimpleDOMParser} from '../dom/native-simple-dom-parser.js';
import {SimpleDOMParser} from '../dom/simple-dom-parser.js';
import {isStringEntirelyKana} from '../language/ja/japanese.js';

/** @type {RequestInit} */
const DEFAULT_REQUEST_INIT_PARAMS = {
    method: 'GET',
    mode: 'cors',
    cache: 'default',
    credentials: 'omit',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
};

export class AudioDownloader {
    /**
     * @param {RequestBuilder} requestBuilder
     */
    constructor(requestBuilder) {
        /** @type {RequestBuilder} */
        this._requestBuilder = requestBuilder;
        /** @type {?JsonSchema} */
        this._customAudioListSchema = null;
        /** @type {Map<import('settings').AudioSourceType, import('audio-downloader').GetInfoHandler>} */
        this._getInfoHandlers = new Map(/** @type {[name: import('settings').AudioSourceType, handler: import('audio-downloader').GetInfoHandler][]} */ ([
            ['jpod101', this._getInfoJpod101.bind(this)],
            ['language-pod-101', this._getInfoLanguagePod101.bind(this)],
            ['jisho', this._getInfoJisho.bind(this)],
            ['lingua-libre', this._getInfoLinguaLibre.bind(this)],
            ['wiktionary', this._getInfoWiktionary.bind(this)],
            ['text-to-speech', this._getInfoTextToSpeech.bind(this)],
            ['text-to-speech-reading', this._getInfoTextToSpeechReading.bind(this)],
            ['custom', this._getInfoCustom.bind(this)],
            ['custom-json', this._getInfoCustomJson.bind(this)],
        ]));
        /** @type {Intl.DisplayNames} */
        this._regionNames = new Intl.DisplayNames(['en'], {type: 'region'});
    }

    /**
     * @param {import('audio').AudioSourceInfo} source
     * @param {string} term
     * @param {string} reading
     * @param {import('language').LanguageSummary} languageSummary
     * @returns {Promise<import('audio-downloader').Info[]>}
     */
    async getTermAudioInfoList(source, term, reading, languageSummary) {
        const handler = this._getInfoHandlers.get(source.type);
        if (typeof handler === 'function') {
            try {
                return await handler(term, reading, source, languageSummary);
            } catch (e) {
                // NOP
            }
        }
        return [];
    }

    /**
     * @param {import('audio').AudioSourceInfo[]} sources
     * @param {?number} preferredAudioIndex
     * @param {string} term
     * @param {string} reading
     * @param {?number} idleTimeout
     * @param {import('language').LanguageSummary} languageSummary
     * @param {boolean} enableDefaultAudioSources
     * @returns {Promise<import('audio-downloader').AudioBinaryBase64>}
     */
    async downloadTermAudio(sources, preferredAudioIndex, term, reading, idleTimeout, languageSummary, enableDefaultAudioSources) {
        const errors = [];
        const requiredAudioSources = enableDefaultAudioSources ? getRequiredAudioSources(languageSummary.iso, sources) : [];
        for (const source of [...sources, ...requiredAudioSources]) {
            let infoList = await this.getTermAudioInfoList(source, term, reading, languageSummary);
            if (typeof preferredAudioIndex === 'number') {
                infoList = (preferredAudioIndex >= 0 && preferredAudioIndex < infoList.length ? [infoList[preferredAudioIndex]] : []);
            }
            for (const info of infoList) {
                switch (info.type) {
                    case 'url':
                        try {
                            return await this._downloadAudioFromUrl(info.url, source.type, idleTimeout);
                        } catch (e) {
                            errors.push(e);
                        }
                        break;
                }
            }
        }

        const error = new ExtensionError('Could not download audio');
        error.data = {errors};
        throw error;
    }

    // Private

    /**
     * @param {string} url
     * @param {string} base
     * @returns {string}
     */
    _normalizeUrl(url, base) {
        return new URL(url, base).href;
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoJpod101(term, reading) {
        if (reading === term && isStringEntirelyKana(term)) {
            reading = term;
            term = '';
        }

        const params = new URLSearchParams();
        if (term.length > 0) {
            params.set('kanji', term);
        }
        if (reading.length > 0) {
            params.set('kana', reading);
        }

        const url = `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?${params.toString()}`;
        return [{type: 'url', url}];
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoLanguagePod101(term, reading, _details, languageSummary) {
        const {name: language} = languageSummary;

        const fetchUrl = this._getLanguagePod101FetchUrl(language);
        const data = new URLSearchParams({
            post: 'dictionary_reference',
            match_type: 'exact',
            search_query: term,
            vulgar: 'true',
        });
        const response = await this._requestBuilder.fetchAnonymous(fetchUrl, {
            ...DEFAULT_REQUEST_INIT_PARAMS,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: data,
        });
        const responseText = await response.text();

        const dom = this._createSimpleDOMParser(responseText);
        /** @type {Set<string>} */
        const urls = new Set();
        for (const row of dom.getElementsByClassName('dc-result-row')) {
            try {
                const audio = dom.getElementByTagName('audio', row);
                if (audio === null) { continue; }

                const source = dom.getElementByTagName('source', audio);
                if (source === null) { continue; }

                let url = dom.getAttribute(source, 'src');
                if (url === null) { continue; }

                if (!this._validateLanguagePod101Row(language, dom, row, term, reading)) { continue; }
                url = this._normalizeUrl(url, response.url);
                urls.add(url);
            } catch (e) {
                // NOP
            }
        }
        return [...urls].map((url) => ({type: 'url', url}));
    }

    /**
     * @param {string} language
     * @param {import('simple-dom-parser').ISimpleDomParser} dom
     * @param {import('simple-dom-parser').Element} row
     * @param {string} term
     * @param {string} reading
     * @returns {boolean}
     */
    _validateLanguagePod101Row(language, dom, row, term, reading) {
        switch (language) {
            case 'Japanese': {
                const htmlReadings = dom.getElementsByClassName('dc-vocab_kana', row);
                if (htmlReadings.length === 0) { return false; }

                const htmlReading = dom.getTextContent(htmlReadings[0]);
                if (!htmlReading) { return false; }
                if (reading !== term && reading !== htmlReading) { return false; }
            } break;
            default: {
                const vocab = dom.getElementsByClassName('dc-vocab', row);
                if (vocab.length === 0) { return false; }

                if (term !== dom.getTextContent(vocab[0])) { return false; }
            }
        }
        return true;
    }

    /**
     * @param {string} language
     * @returns {string}
     */
    _getLanguagePod101FetchUrl(language) {
        const podOrClass = this._getLanguagePod101PodOrClass(language);
        const lowerCaseLanguage = language.toLowerCase();
        return `https://www.${lowerCaseLanguage}${podOrClass}101.com/learningcenter/reference/dictionary_post`;
    }

    /**
     * - https://languagepod101.com/
     * @param {string} language
     * @returns {'pod'|'class'}
     * @throws {Error}
     */
    _getLanguagePod101PodOrClass(language) {
        switch (language) {
            case 'Afrikaans':
            case 'Arabic':
            case 'Bulgarian':
            case 'Dutch':
            case 'Filipino':
            case 'Finnish':
            case 'French':
            case 'German':
            case 'Greek':
            case 'Hebrew':
            case 'Hindi':
            case 'Hungarian':
            case 'Indonesian':
            case 'Italian':
            case 'Japanese':
            case 'Persian':
            case 'Polish':
            case 'Portuguese':
            case 'Romanian':
            case 'Russian':
            case 'Spanish':
            case 'Swahili':
            case 'Swedish':
            case 'Thai':
            case 'Urdu':
            case 'Vietnamese':
                return 'pod';
            case 'Cantonese':
            case 'Chinese':
            case 'Czech':
            case 'Danish':
            case 'English':
            case 'Korean':
            case 'Norwegian':
            case 'Turkish':
                return 'class';
            default:
                throw new Error('Invalid language for LanguagePod101');
        }
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoJisho(term, reading) {
        const fetchUrl = `https://jisho.org/search/${term}`;
        const response = await this._requestBuilder.fetchAnonymous(fetchUrl, DEFAULT_REQUEST_INIT_PARAMS);
        const responseText = await response.text();

        const dom = this._createSimpleDOMParser(responseText);
        try {
            const audio = dom.getElementById(`audio_${term}:${reading}`);
            if (audio !== null) {
                const source = dom.getElementByTagName('source', audio);
                if (source !== null) {
                    let url = dom.getAttribute(source, 'src');
                    if (url !== null) {
                        url = this._normalizeUrl(url, response.url);
                        return [{type: 'url', url}];
                    }
                }
            }
        } catch (e) {
            // NOP
        }

        throw new Error('Failed to find audio URL');
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoLinguaLibre(term, _reading, _details, languageSummary) {
        if (typeof languageSummary !== 'object' || languageSummary === null) {
            throw new Error('Invalid arguments');
        }
        const {iso639_3} = languageSummary;
        const searchCategory = `incategory:"Lingua_Libre_pronunciation-${iso639_3}"`;
        const searchString = `-${term}.wav`;
        const fetchUrl = `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srsearch=intitle:/${searchString}/i+${searchCategory}&srnamespace=6&origin=*`;

        /**
         * @param {string} filename
         * @param {string} fileUser
         * @returns {boolean}
         */
        const validateFilename = (filename, fileUser) => {
            const validFilenameTest = new RegExp(`^File:LL-Q\\d+\\s+\\(${iso639_3}\\)-${fileUser}-${term}\\.wav$`, 'i');
            return validFilenameTest.test(filename);
        };

        return await this._getInfoWikimediaCommons(fetchUrl, validateFilename);
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoWiktionary(term, _reading, _details, languageSummary) {
        if (typeof languageSummary !== 'object' || languageSummary === null) {
            throw new Error('Invalid arguments');
        }
        const {iso} = languageSummary;
        const searchString = `${iso}(-[a-zA-Z]{2})?-${term}[0123456789]*.ogg`;
        const fetchUrl = `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srsearch=intitle:/${searchString}/i&srnamespace=6&origin=*`;

        /**
         * @param {string} filename
         * @returns {boolean}
         */
        const validateFilename = (filename) => {
            const validFilenameTest = new RegExp(`^File:${iso}(-\\w\\w)?-${term}\\d*\\.ogg$`, 'i');
            return validFilenameTest.test(filename);
        };

        /**
         * @param {string} filename
         * @param {string} fileUser
         * @returns {string}
         */
        const displayName = (filename, fileUser) => {
            const match = filename.match(new RegExp(`^File:${iso}(-\\w\\w)-${term}`, 'i'));
            if (match === null) {
                return fileUser;
            }
            const region = match[1].substring(1).toUpperCase();
            const regionName = this._regionNames.of(region);
            return `(${regionName}) ${fileUser}`;
        };

        return await this._getInfoWikimediaCommons(fetchUrl, validateFilename, displayName);
    }

    /**
     * @param {string} fetchUrl
     * @param {(filename: string, fileUser: string) => boolean} validateFilename
     * @param {(filename: string, fileUser: string) => string} [displayName]
     * @returns {Promise<import('audio-downloader').Info1[]>}
     */
    async _getInfoWikimediaCommons(fetchUrl, validateFilename, displayName = (_filename, fileUser) => fileUser) {
        const response = await this._requestBuilder.fetchAnonymous(fetchUrl, DEFAULT_REQUEST_INIT_PARAMS);

        /** @type {import('audio-downloader').WikimediaCommonsLookupResponse} */
        const lookupResponse = await readResponseJson(response);
        const lookupResults = lookupResponse.query.search;

        const fetchFileInfos = lookupResults.map(async ({title}) => {
            const fileInfoURL = `https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=${title}&prop=imageinfo&iiprop=user|url&origin=*`;
            const response2 = await this._requestBuilder.fetchAnonymous(fileInfoURL, DEFAULT_REQUEST_INIT_PARAMS);
            /** @type {import('audio-downloader').WikimediaCommonsFileResponse} */
            const fileResponse = await readResponseJson(response2);
            const fileResults = fileResponse.query.pages;
            const results = [];
            for (const page of Object.values(fileResults)) {
                const fileUrl = page.imageinfo[0].url;
                const fileUser = page.imageinfo[0].user;
                if (validateFilename(title, fileUser)) {
                    results.push({type: 'url', url: fileUrl, name: displayName(title, fileUser)});
                }
            }
            return /** @type {import('audio-downloader').Info1[]} */ (results);
        });

        return (await Promise.all(fetchFileInfos)).flat();
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoTextToSpeech(term, reading, details) {
        if (typeof details !== 'object' || details === null) {
            throw new Error('Invalid arguments');
        }
        const {voice} = details;
        if (typeof voice !== 'string') {
            throw new Error('Invalid voice');
        }
        return [{type: 'tts', text: term, voice: voice}];
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoTextToSpeechReading(term, reading, details) {
        if (typeof details !== 'object' || details === null) {
            throw new Error('Invalid arguments');
        }
        const {voice} = details;
        if (typeof voice !== 'string') {
            throw new Error('Invalid voice');
        }
        return [{type: 'tts', text: reading, voice: voice}];
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoCustom(term, reading, details, languageSummary) {
        if (typeof details !== 'object' || details === null) {
            throw new Error('Invalid arguments');
        }
        let {url} = details;
        if (typeof url !== 'string') {
            throw new Error('Invalid url');
        }
        url = this._getCustomUrl(term, reading, url, languageSummary);
        return [{type: 'url', url}];
    }

    /** @type {import('audio-downloader').GetInfoHandler} */
    async _getInfoCustomJson(term, reading, details, languageSummary) {
        if (typeof details !== 'object' || details === null) {
            throw new Error('Invalid arguments');
        }
        let {url} = details;
        if (typeof url !== 'string') {
            throw new Error('Invalid url');
        }
        url = this._getCustomUrl(term, reading, url, languageSummary);

        const response = await this._requestBuilder.fetchAnonymous(url, DEFAULT_REQUEST_INIT_PARAMS);

        if (!response.ok) {
            throw new Error(`Invalid response: ${response.status}`);
        }

        /** @type {import('audio-downloader').CustomAudioList} */
        const responseJson = await readResponseJson(response);

        if (this._customAudioListSchema === null) {
            const schema = await this._getCustomAudioListSchema();
            this._customAudioListSchema = new JsonSchema(/** @type {import('ext/json-schema').Schema} */ (schema));
        }
        this._customAudioListSchema.validate(responseJson);

        /** @type {import('audio-downloader').Info[]} */
        const results = [];
        for (const {url: url2, name} of responseJson.audioSources) {
            /** @type {import('audio-downloader').Info1} */
            const info = {type: 'url', url: url2};
            if (typeof name === 'string') { info.name = name; }
            results.push(info);
        }
        return results;
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @param {string} url
     * @param {import('language').LanguageSummary} languageSummary
     * @returns {string}
     * @throws {Error}
     */
    _getCustomUrl(term, reading, url, languageSummary) {
        if (typeof url !== 'string') {
            throw new Error('No custom URL defined');
        }
        const data = {
            term,
            reading,
            language: languageSummary.iso,
        };
        /**
         * @param {string} m0
         * @param {string} m1
         * @returns {string}
         */
        const replacer = (m0, m1) => (
            Object.prototype.hasOwnProperty.call(data, m1) ?
            `${data[/** @type {'term'|'reading'|'language'} */ (m1)]}` :
            m0
        );
        return url.replace(/\{([^}]*)\}/g, replacer);
    }

    /**
     * @param {string} url
     * @param {import('settings').AudioSourceType} sourceType
     * @param {?number} idleTimeout
     * @returns {Promise<import('audio-downloader').AudioBinaryBase64>}
     */
    async _downloadAudioFromUrl(url, sourceType, idleTimeout) {
        let signal;
        /** @type {?import('request-builder.js').ProgressCallback} */
        let onProgress = null;
        /** @type {?import('core').Timeout} */
        let idleTimer = null;
        if (typeof idleTimeout === 'number') {
            const abortController = new AbortController();
            ({signal} = abortController);
            const onIdleTimeout = () => {
                abortController.abort('Idle timeout');
            };
            onProgress = (done) => {
                if (idleTimer !== null) {
                    clearTimeout(idleTimer);
                }
                idleTimer = done ? null : setTimeout(onIdleTimeout, idleTimeout);
            };
            idleTimer = setTimeout(onIdleTimeout, idleTimeout);
        }

        const response = await this._requestBuilder.fetchAnonymous(url, {
            ...DEFAULT_REQUEST_INIT_PARAMS,
            signal,
        });

        if (!response.ok) {
            throw new Error(`Invalid response: ${response.status}`);
        }

        const arrayBuffer = await RequestBuilder.readFetchResponseArrayBuffer(response, onProgress);

        if (idleTimer !== null) {
            clearTimeout(idleTimer);
        }

        if (!await this._isAudioBinaryValid(arrayBuffer, sourceType)) {
            throw new Error('Could not retrieve audio');
        }

        const data = arrayBufferToBase64(arrayBuffer);
        const contentType = response.headers.get('Content-Type');
        return {data, contentType};
    }

    /**
     * @param {ArrayBuffer} arrayBuffer
     * @param {import('settings').AudioSourceType} sourceType
     * @returns {Promise<boolean>}
     */
    async _isAudioBinaryValid(arrayBuffer, sourceType) {
        switch (sourceType) {
            case 'jpod101':
            {
                const digest = await this._arrayBufferDigest(arrayBuffer);
                switch (digest) {
                    case 'ae6398b5a27bc8c0a771df6c907ade794be15518174773c58c7c7ddd17098906': // Invalid audio
                        return false;
                    default:
                        return true;
                }
            }
            default:
                return true;
        }
    }

    /**
     * @param {ArrayBuffer} arrayBuffer
     * @returns {Promise<string>}
     */
    async _arrayBufferDigest(arrayBuffer) {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(arrayBuffer)));
        let digest = '';
        for (const byte of hash) {
            digest += byte.toString(16).padStart(2, '0');
        }
        return digest;
    }

    /**
     * @param {string} content
     * @returns {import('simple-dom-parser').ISimpleDomParser}
     * @throws {Error}
     */
    _createSimpleDOMParser(content) {
        if (typeof NativeSimpleDOMParser !== 'undefined' && NativeSimpleDOMParser.isSupported()) {
            return new NativeSimpleDOMParser(content);
        } else if (typeof SimpleDOMParser !== 'undefined' && SimpleDOMParser.isSupported()) {
            return new SimpleDOMParser(content);
        } else {
            throw new Error('DOM parsing not supported');
        }
    }

    /**
     * @returns {Promise<unknown>}
     */
    async _getCustomAudioListSchema() {
        const url = chrome.runtime.getURL('/data/schemas/custom-audio-list-schema.json');
        const response = await fetch(url, {
            ...DEFAULT_REQUEST_INIT_PARAMS,
            mode: 'no-cors',
        });
        return await readResponseJson(response);
    }
}

/**
 * @param {string} language
 * @returns {Set<import('settings').AudioSourceType>}
 */
export function getRequiredAudioSourceList(language) {
    return language === 'ja' ?
        new Set([
            'jpod101',
            'language-pod-101',
            'jisho',
        ]) :
        new Set([
            'lingua-libre',
            'language-pod-101',
            'wiktionary',
        ]);
}

/**
 * @param {string} language
 * @param {import('audio').AudioSourceInfo[]} sources
 * @returns {import('audio').AudioSourceInfo[]}
 */
export function getRequiredAudioSources(language, sources) {
    /** @type {Set<import('settings').AudioSourceType>} */
    const requiredSources = getRequiredAudioSourceList(language);

    for (const {type} of sources) {
        requiredSources.delete(type);
    }

    return [...requiredSources].map((type) => ({type, url: '', voice: ''}));
}
