/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {isObjectNotArray} from '../../core/object-utilities.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class PersistentStorageController {
    /**
     * @param {import('../../application.js').Application} application
     */
    constructor(application) {
        /** @type {import('../../application.js').Application} */
        this._application = application;
        /** @type {HTMLInputElement} */
        this._persistentStorageCheckbox = querySelectorNotNull(document, '#storage-persistent-checkbox');
    }

    /** @type {import('../../application.js').Application} */
    get application() {
        return this._application;
    }

    /** */
    async prepare() {
        this._persistentStorageCheckbox.addEventListener('change', this._onPersistentStorageCheckboxChange.bind(this), false);

        if (!this._isPersistentStorageSupported()) { return; }

        /** @type {?HTMLElement} */
        const info = document.querySelector('#storage-persistent-info');
        if (info !== null) { info.hidden = false; }

        const isStoragePeristent = await this.isStoragePeristent();
        this._updateCheckbox(isStoragePeristent);
    }

    /**
     * @returns {Promise<boolean>}
     */
    async isStoragePeristent() {
        try {
            return await navigator.storage.persisted();
        } catch (e) {
            // NOP
        }
        return false;
    }

    // Private

    /**
     * @param {Event} e
     */
    _onPersistentStorageCheckboxChange(e) {
        const node = /** @type {HTMLInputElement} */ (e.currentTarget);
        if (node.checked) {
            node.checked = false;
            void this._attemptPersistStorage();
        } else {
            node.checked = true;
        }
    }

    /** */
    async _attemptPersistStorage() {
        let isStoragePeristent = false;
        try {
            isStoragePeristent = await navigator.storage.persist();
        } catch (e) {
            // NOP
        }

        this._updateCheckbox(isStoragePeristent);

        /** @type {?HTMLElement} */
        const node = document.querySelector('#storage-persistent-fail-warning');
        if (node !== null) { node.hidden = isStoragePeristent; }

        this._application.triggerStorageChanged();
    }

    /**
     * @returns {boolean}
     */
    _isPersistentStorageSupported() {
        return isObjectNotArray(navigator.storage) && typeof navigator.storage.persist === 'function';
    }

    /**
     * @param {boolean} isStoragePeristent
     */
    _updateCheckbox(isStoragePeristent) {
        /** @type {HTMLInputElement} */ (this._persistentStorageCheckbox).checked = isStoragePeristent;
        /** @type {HTMLInputElement} */ (this._persistentStorageCheckbox).readOnly = isStoragePeristent;
    }
}
