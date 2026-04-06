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

/**
 * @typedef {object} GsmOverlayRecommendationCustomOperationSetMainScanModifierKey
 * @property {'setMainScanModifierKey'} action
 * @property {'none'|'alt'|'ctrl'|'shift'|'meta'} value
 */

/**
 * @typedef {import('settings-modifications').Modification|GsmOverlayRecommendationCustomOperationSetMainScanModifierKey} GsmOverlayRecommendationOperation
 */

/**
 * @typedef {object} GsmOverlayRecommendationSetting
 * @property {string} description
 * @property {GsmOverlayRecommendationOperation} operation
 */

/**
 * @typedef {object} GsmOverlayRecommendationPack
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {boolean} suppressPromptOnFreshInstall
 * @property {GsmOverlayRecommendationSetting[]} settings
 */

export const defaultCustomPopupCss = [
    'body {',
    '    background: transparent !important;',
    '    color: #dfdfdf;',
    '}',
    '',
    '.gloss-sc-thead,',
    '.gloss-sc-tfoot,',
    '.gloss-sc-th {',
    '    background-color: transparent;',
    '}',
    '',
    '.headword-term > ruby > rt {',
    '    color: #979797;',
    '}',
].join('\n');

export const defaultCustomPopupOuterCss = [
    'iframe.yomitan-popup {',
    '    background: rgba(45, 45, 55, 0.85) !important;',
    '    backdrop-filter: blur(6px) !important;',
    '    -webkit-backdrop-filter: blur(6px) !important;',
    '    border-radius: 12px !important;',
    '    border: 1px solid rgba(255, 255, 255, 0.2) !important;',
    '}',
].join('\n');

/**
 * Add new GSM overlay recommendation packs here.
 *
 * Expansion checklist:
 * 1. Add a new pack with a unique `id`.
 * 2. Set `suppressPromptOnFreshInstall` if new users should not be prompted for that pack.
 * 3. Add one or more `settings` entries.
 * 4. If you use a custom `operation.action`, implement it in
 *    `pages/settings/gsm-overlay-recommended-settings-controller.js`.
 */
/** @type {GsmOverlayRecommendationPack[]} */
export const gsmOverlayRecommendationPacks = Object.freeze([
    Object.freeze({
        id: 'overlay-glass-popup',
        title: 'Use the GSM glass popup appearance',
        description: 'Applies the popup CSS that matches GSM\'s transparent overlay.',
        suppressPromptOnFreshInstall: true,
        settings: Object.freeze([
            Object.freeze({
                description: 'Set Popup CSS to the GSM glass theme.',
                operation: Object.freeze({
                    action: 'set',
                    path: 'general.customPopupCss',
                    value: defaultCustomPopupCss,
                }),
            }),
            Object.freeze({
                description: 'Set Popup outer CSS to the GSM glass frame theme.',
                operation: Object.freeze({
                    action: 'set',
                    path: 'general.customPopupOuterCss',
                    value: defaultCustomPopupOuterCss,
                }),
            }),
        ]),
    }),
    Object.freeze({
        id: 'overlay-hover-scanning',
        title: 'Use GSM\'s hover scanning behavior',
        description: 'Tunes the current profile for the overlay: hover to scan, avoid text selection, and close popups quickly when the cursor leaves them.',
        suppressPromptOnFreshInstall: true,
        settings: Object.freeze([
            Object.freeze({
                description: 'Set Scan modifier key to No key.',
                operation: Object.freeze({
                    action: 'setMainScanModifierKey',
                    value: 'none',
                }),
            }),
            Object.freeze({
                description: 'Disable Select matched text.',
                operation: Object.freeze({
                    action: 'set',
                    path: 'scanning.selectText',
                    value: false,
                }),
            }),
            Object.freeze({
                description: 'Enable Auto-hide search popup.',
                operation: Object.freeze({
                    action: 'set',
                    path: 'scanning.autoHideResults',
                    value: true,
                }),
            }),
            Object.freeze({
                description: 'Enable Hide popup on cursor exit.',
                operation: Object.freeze({
                    action: 'set',
                    path: 'scanning.hidePopupOnCursorExit',
                    value: true,
                }),
            }),
            Object.freeze({
                description: 'Set Hide popup on cursor exit delay to 50 ms.',
                operation: Object.freeze({
                    action: 'set',
                    path: 'scanning.hidePopupOnCursorExitDelay',
                    value: 50,
                }),
            }),
        ]),
    }),
]);

/**
 * @returns {string[]}
 */
export function getGsmOverlayRecommendationPackIdsSuppressedOnFreshInstall() {
    return gsmOverlayRecommendationPacks
        .filter(({suppressPromptOnFreshInstall}) => suppressPromptOnFreshInstall)
        .map(({id}) => id);
}
