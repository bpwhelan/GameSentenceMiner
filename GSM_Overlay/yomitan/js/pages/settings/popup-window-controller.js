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

import {querySelectorNotNull} from '../../dom/query-selector.js';

export class PopupWindowController {
    /**
     * @param {import('../../comm/api.js').API} api
     */
    constructor(api) {
        /** @type {import('../../comm/api.js').API} */
        this._api = api;
    }

    /** */
    prepare() {
        /** @type {HTMLElement} */
        const testLink = querySelectorNotNull(document, '#test-window-open-link');
        testLink.addEventListener('click', this._onTestWindowOpenLinkClick.bind(this), false);
    }

    // Private

    /**
     * @param {MouseEvent} e
     */
    _onTestWindowOpenLinkClick(e) {
        e.preventDefault();
        void this._testWindowOpen();
    }

    /** */
    async _testWindowOpen() {
        await this._api.getOrCreateSearchPopup({focus: true});
    }
}
