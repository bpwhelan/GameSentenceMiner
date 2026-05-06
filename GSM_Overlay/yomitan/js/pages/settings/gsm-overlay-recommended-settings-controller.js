/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {log} from '../../core/log.js';
import {deepEqual} from '../../core/utilities.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {ObjectPropertyAccessor} from '../../general/object-property-accessor.js';
import {gsmOverlayRecommendationPacks} from '../../data/gsm-overlay-recommended-settings.js';
import {ScanInputsController} from './scan-inputs-controller.js';

export class GsmOverlayRecommendedSettingsController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('./modal-controller.js').ModalController} modalController
     */
    constructor(settingsController, modalController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('./modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {HTMLElement} */
        this._list = querySelectorNotNull(document, '#gsm-overlay-recommended-settings-list');
        /** @type {HTMLButtonElement} */
        this._dismissButton = querySelectorNotNull(document, '#gsm-overlay-recommended-settings-dismiss-button');
        /** @type {HTMLButtonElement} */
        this._applyButton = querySelectorNotNull(document, '#gsm-overlay-recommended-settings-apply-button');
        /** @type {HTMLButtonElement} */
        this._openButton = querySelectorNotNull(document, '#gsm-overlay-recommended-settings-open-button');
        /** @type {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationPack[]} */
        this._shownPacks = [];
        /** @type {'automatic'|'manual'} */
        this._promptMode = 'automatic';
    }

    /** */
    async prepare() {
        this._dismissButton.addEventListener('click', this._onDismissButtonClick.bind(this), false);
        this._applyButton.addEventListener('click', this._onApplyButtonClick.bind(this), false);
        this._openButton.addEventListener('click', this._onOpenButtonClick.bind(this), false);
        await this._showPromptIfNeeded();
    }

    // Private

    /** */
    async _showPromptIfNeeded() {
        const optionsFull = await this._settingsController.getOptionsFull();
        const options = await this._settingsController.getOptions();
        const pendingPacks = this._getPendingPacks(optionsFull, options);
        if (pendingPacks.length === 0) { return; }

        const selectedPackIds = pendingPacks.map(({id}) => id);
        this._showPrompt(pendingPacks, selectedPackIds, 'automatic');
    }

    /**
     * @param {MouseEvent} e
     */
    _onOpenButtonClick(e) {
        e.preventDefault();
        void this._showAllRecommendations();
    }

    /** */
    async _showAllRecommendations() {
        const options = await this._settingsController.getOptions();
        const selectedPackIds = gsmOverlayRecommendationPacks
            .filter((pack) => !this._isPackSatisfied(pack, options))
            .map(({id}) => id);
        this._showPrompt(gsmOverlayRecommendationPacks, selectedPackIds, 'manual');
    }

    /**
     * @param {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationPack[]} packs
     * @param {string[]} selectedPackIds
     * @param {'automatic'|'manual'} mode
     */
    _showPrompt(packs, selectedPackIds, mode) {
        this._shownPacks = packs;
        this._promptMode = mode;
        this._renderPacks(packs, new Set(selectedPackIds));
        const modal = this._modalController.getModal('gsm-overlay-recommended-settings');
        if (modal !== null) {
            modal.setVisible(true);
        }
    }

    /**
     * @param {MouseEvent} e
     */
    _onDismissButtonClick(e) {
        e.preventDefault();
        if (this._promptMode === 'manual') {
            this._closePrompt();
            return;
        }
        void this._resolvePrompt([], this._shownPacks.map(({id}) => id));
    }

    /**
     * @param {MouseEvent} e
     */
    _onApplyButtonClick(e) {
        e.preventDefault();
        /** @type {string[]} */
        const selectedPackIds = [];
        for (const checkbox of this._list.querySelectorAll('input[type="checkbox"]:checked')) {
            selectedPackIds.push(/** @type {HTMLInputElement} */ (checkbox).value);
        }

        const shownPackIds = this._shownPacks.map(({id}) => id);
        const dismissedPackIds = (
            this._promptMode === 'automatic' ?
            shownPackIds.filter((id) => !selectedPackIds.includes(id)) :
            []
        );
        void this._resolvePrompt(selectedPackIds, dismissedPackIds);
    }

    /**
     * @param {string[]} selectedPackIds
     * @param {string[]} dismissedPackIds
     */
    async _resolvePrompt(selectedPackIds, dismissedPackIds) {
        const selectedPacks = this._shownPacks.filter(({id}) => selectedPackIds.includes(id));
        if (selectedPacks.length > 0) {
            const options = await this._settingsController.getOptions();
            const modifications = this._getPackModifications(selectedPacks, options);
            const results = await this._settingsController.modifyProfileSettings(modifications);
            if (results.some((result) => Object.hasOwn(result, 'error'))) {
                for (const result of results) {
                    if (Object.hasOwn(result, 'error')) {
                        log.error(new Error(`Failed to apply GSM overlay recommendation: ${JSON.stringify(result)}`));
                    }
                }
                return;
            }
            await this._settingsController.refresh();
        }

        const optionsFull = await this._settingsController.getOptionsFull();
        const nextState = this._createNextRecommendationState(optionsFull, selectedPackIds, dismissedPackIds);
        await this._settingsController.setGlobalSetting('global.gsmOverlayRecommendations', nextState);

        this._closePrompt();
    }

    /**
     * @param {import('settings').Options} optionsFull
     * @param {string[]} appliedPackIds
     * @param {string[]} dismissedPackIds
     * @returns {import('settings').GsmOverlayRecommendationsState}
     */
    _createNextRecommendationState(optionsFull, appliedPackIds, dismissedPackIds) {
        const currentState = this._getRecommendationState(optionsFull);
        return {
            appliedPackIds: [...new Set([...currentState.appliedPackIds, ...appliedPackIds])],
            dismissedPackIds: [...new Set([...currentState.dismissedPackIds, ...dismissedPackIds])],
            freshInstallSuppressedPackIds: currentState.freshInstallSuppressedPackIds,
        };
    }

    /**
     * @param {import('settings').Options} optionsFull
     * @param {import('settings').ProfileOptions} options
     * @returns {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationPack[]}
     */
    _getPendingPacks(optionsFull, options) {
        const recommendationState = this._getRecommendationState(optionsFull);
        const resolvedPackIds = new Set([
            ...recommendationState.appliedPackIds,
            ...recommendationState.dismissedPackIds,
            ...recommendationState.freshInstallSuppressedPackIds,
        ]);

        return gsmOverlayRecommendationPacks.filter((pack) => {
            if (resolvedPackIds.has(pack.id)) { return false; }
            return !this._isPackSatisfied(pack, options);
        });
    }

    /**
     * @param {import('settings').Options} optionsFull
     * @returns {import('settings').GsmOverlayRecommendationsState}
     */
    _getRecommendationState(optionsFull) {
        return optionsFull.global.gsmOverlayRecommendations;
    }

    /**
     * @param {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationPack[]} packs
     * @param {Set<string>} selectedPackIds
     */
    _renderPacks(packs, selectedPackIds) {
        this._list.textContent = '';
        for (const pack of packs) {
            const template = /** @type {HTMLElement} */ (this._settingsController.instantiateTemplate('gsm-overlay-recommended-settings-pack'));
            const checkbox = /** @type {HTMLInputElement} */ (querySelectorNotNull(template, '.gsm-overlay-recommended-settings-pack-checkbox'));
            const title = querySelectorNotNull(template, '.gsm-overlay-recommended-settings-pack-title');
            const description = querySelectorNotNull(template, '.gsm-overlay-recommended-settings-pack-description');
            const settingsList = /** @type {HTMLElement} */ (querySelectorNotNull(template, '.gsm-overlay-recommended-settings-pack-list'));

            checkbox.value = pack.id;
            checkbox.checked = selectedPackIds.has(pack.id);
            title.textContent = pack.title;
            description.textContent = `${pack.description} Applies to the current Yomitan profile.`;

            for (const {description: settingDescription} of pack.settings) {
                const listItem = document.createElement('li');
                listItem.textContent = settingDescription;
                settingsList.appendChild(listItem);
            }

            this._list.appendChild(template);
        }
    }

    /** */
    _closePrompt() {
        this._shownPacks = [];
        this._promptMode = 'automatic';
        const modal = this._modalController.getModal('gsm-overlay-recommended-settings');
        if (modal !== null) {
            modal.setVisible(false);
        }
    }

    /**
     * @param {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationPack} pack
     * @param {import('settings').ProfileOptions} options
     * @returns {boolean}
     */
    _isPackSatisfied(pack, options) {
        for (const {operation} of pack.settings) {
            if (!this._isOperationSatisfied(operation, options)) {
                return false;
            }
        }
        return true;
    }

    /**
     * @param {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationOperation} operation
     * @param {import('settings').ProfileOptions} options
     * @returns {boolean}
     */
    _isOperationSatisfied(operation, options) {
        switch (operation.action) {
            case 'set': {
                try {
                    const accessor = new ObjectPropertyAccessor(options);
                    const path = ObjectPropertyAccessor.getPathArray(operation.path);
                    return deepEqual(accessor.get(path), operation.value);
                } catch (e) {
                    return false;
                }
            }
            case 'setMainScanModifierKey':
                return (this._getMainScanModifierKey(options.scanning.inputs) === operation.value);
            default:
                return false;
        }
    }

    /**
     * @param {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationPack[]} packs
     * @param {import('settings').ProfileOptions} options
     * @returns {import('settings-modifications').Modification[]}
     */
    _getPackModifications(packs, options) {
        /** @type {import('settings-modifications').Modification[]} */
        const modifications = [];
        for (const pack of packs) {
            for (const {operation} of pack.settings) {
                modifications.push(...this._getOperationModifications(operation, options));
            }
        }
        return modifications;
    }

    /**
     * @param {import('../../data/gsm-overlay-recommended-settings.js').GsmOverlayRecommendationOperation} operation
     * @param {import('settings').ProfileOptions} options
     * @returns {import('settings-modifications').Modification[]}
     * @throws {Error} If the operation action is unsupported.
     */
    _getOperationModifications(operation, options) {
        switch (operation.action) {
            case 'set':
            case 'delete':
            case 'swap':
            case 'splice':
            case 'push': {
                const modification = /** @type {import('settings-modifications').Modification} */ (operation);
                return [modification];
            }
            case 'setMainScanModifierKey':
                return this._createMainScanModifierKeyModifications(operation.value, options.scanning.inputs);
            default:
                throw new Error(`Unsupported GSM overlay recommendation action: ${operation.action}`);
        }
    }

    /**
     * @param {string} value
     * @param {import('settings').ScanningInput[]} inputs
     * @returns {import('settings-modifications').Modification[]}
     * @throws {Error} If the modifier key value is unsupported.
     */
    _createMainScanModifierKeyModifications(value, inputs) {
        let include = '';
        switch (value) {
            case 'none':
                include = '';
                break;
            case 'alt':
            case 'ctrl':
            case 'shift':
            case 'meta':
                include = value;
                break;
            default:
                throw new Error(`Unsupported main scan modifier key: ${value}`);
        }

        const index = this._getIndexOfMainScanInput(inputs);
        if (index < 0) {
            return [{
                action: 'splice',
                path: 'scanning.inputs',
                start: inputs.length,
                deleteCount: 0,
                items: [ScanInputsController.createDefaultMouseInput(include, 'mouse0')],
            }];
        }

        return [{
            action: 'set',
            path: `scanning.inputs[${index}].include`,
            value: include,
        }];
    }

    /**
     * @param {import('settings').ScanningInput[]} inputs
     * @returns {string}
     */
    _getMainScanModifierKey(inputs) {
        const index = this._getIndexOfMainScanInput(inputs);
        if (index < 0) { return 'other'; }

        const includeValues = this._splitInputValue(inputs[index].include);
        if (includeValues.length === 0) { return 'none'; }
        if (includeValues.length === 1 && !this._isMouseInput(includeValues[0])) {
            return includeValues[0];
        }
        return 'other';
    }

    /**
     * @param {import('settings').ScanningInput[]} inputs
     * @returns {number}
     */
    _getIndexOfMainScanInput(inputs) {
        for (let i = 0, ii = inputs.length; i < ii; ++i) {
            const {include, exclude, types: {mouse}} = inputs[i];
            if (!mouse) { continue; }
            const includeValues = this._splitInputValue(include);
            const excludeValues = this._splitInputValue(exclude);
            if (
                (
                    includeValues.length === 0 ||
                    (includeValues.length === 1 && !this._isMouseInput(includeValues[0]))
                ) &&
                excludeValues.length === 1 &&
                excludeValues[0] === 'mouse0'
            ) {
                return i;
            }
        }
        return -1;
    }

    /**
     * @param {string} value
     * @returns {string[]}
     */
    _splitInputValue(value) {
        return value.split(/[,;\s]+/).map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0);
    }

    /**
     * @param {string} input
     * @returns {boolean}
     */
    _isMouseInput(input) {
        return /^mouse\d+$/.test(input);
    }
}
