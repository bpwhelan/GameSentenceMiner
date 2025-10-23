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

import {EventListenerCollection} from '../core/event-listener-collection.js';
import {generateId} from '../core/utilities.js';
import {PanelElement} from '../dom/panel-element.js';
import {querySelectorNotNull} from '../dom/query-selector.js';

export class DisplayProfileSelection {
    /**
     * @param {import('./display.js').Display} display
     */
    constructor(display) {
        /** @type {import('./display.js').Display} */
        this._display = display;
        /** @type {HTMLElement} */
        this._profileList = querySelectorNotNull(document, '#profile-list');
        /** @type {HTMLButtonElement} */
        this._profileButton = querySelectorNotNull(document, '#profile-button');
        /** @type {HTMLElement} */
        const profilePanelElement = querySelectorNotNull(document, '#profile-panel');
        /** @type {PanelElement} */
        this._profilePanel = new PanelElement(profilePanelElement, 375); // Milliseconds; includes buffer
        /** @type {boolean} */
        this._profileListNeedsUpdate = false;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {string} */
        this._source = generateId(16);
        /** @type {HTMLElement} */
        this._profileName = querySelectorNotNull(document, '#profile-name');
    }

    /** */
    async prepare() {
        this._display.application.on('optionsUpdated', this._onOptionsUpdated.bind(this));
        this._profileButton.addEventListener('click', this._onProfileButtonClick.bind(this), false);
        this._profileListNeedsUpdate = true;
        await this._updateCurrentProfileName();
    }

    // Private

    /**
     * @param {{source: string}} details
     */
    async _onOptionsUpdated({source}) {
        if (source === this._source) { return; }
        this._profileListNeedsUpdate = true;
        if (this._profilePanel.isVisible()) {
            void this._updateProfileList();
        }
        await this._updateCurrentProfileName();
    }

    /**
     * @param {MouseEvent} e
     */
    _onProfileButtonClick(e) {
        e.preventDefault();
        e.stopPropagation();
        this._setProfilePanelVisible(!this._profilePanel.isVisible());
    }

    /**
     * @param {boolean} visible
     */
    _setProfilePanelVisible(visible) {
        this._profilePanel.setVisible(visible);
        this._profileButton.classList.toggle('sidebar-button-highlight', visible);
        document.documentElement.dataset.profilePanelVisible = `${visible}`;
        if (visible && this._profileListNeedsUpdate) {
            void this._updateProfileList();
        }
    }

    /** */
    async _updateCurrentProfileName() {
        const {profileCurrent, profiles} = await this._display.application.api.optionsGetFull();
        if (profiles.length === 1) {
            this._profileButton.style.display = 'none';
            return;
        }
        const currentProfile = profiles[profileCurrent];
        this._profileName.textContent = currentProfile.name;
    }

    /** */
    async _updateProfileList() {
        this._profileListNeedsUpdate = false;
        const options = await this._display.application.api.optionsGetFull();

        this._eventListeners.removeAllEventListeners();
        const displayGenerator = this._display.displayGenerator;

        const {profileCurrent, profiles} = options;
        const fragment = document.createDocumentFragment();
        for (let i = 0, ii = profiles.length; i < ii; ++i) {
            const {name} = profiles[i];
            const entry = displayGenerator.createProfileListItem();
            /** @type {HTMLInputElement} */
            const radio = querySelectorNotNull(entry, '.profile-entry-is-default-radio');
            radio.checked = (i === profileCurrent);
            /** @type {Element} */
            const nameNode = querySelectorNotNull(entry, '.profile-list-item-name');
            nameNode.textContent = name;
            fragment.appendChild(entry);
            this._eventListeners.addEventListener(radio, 'change', this._onProfileRadioChange.bind(this, i), false);
        }
        this._profileList.textContent = '';
        this._profileList.appendChild(fragment);
    }

    /**
     * @param {number} index
     * @param {Event} e
     */
    _onProfileRadioChange(index, e) {
        const element = /** @type {HTMLInputElement} */ (e.currentTarget);
        if (element.checked) {
            void this._setProfileCurrent(index);
        }
    }

    /**
     * @param {number} index
     */
    async _setProfileCurrent(index) {
        /** @type {import('settings-modifications').ScopedModificationSet} */
        const modification = {
            action: 'set',
            path: 'profileCurrent',
            value: index,
            scope: 'global',
            optionsContext: null,
        };
        await this._display.application.api.modifySettings([modification], this._source);
        this._setProfilePanelVisible(false);
        await this._updateCurrentProfileName();
    }
}
