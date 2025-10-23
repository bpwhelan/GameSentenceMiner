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
import {log} from '../core/log.js';
import {generateId} from '../core/utilities.js';

export class FrameEndpoint {
    /**
     * @param {import('../comm/api.js').API} api
     */
    constructor(api) {
        /** @type {import('../comm/api.js').API} */
        this._api = api;
        /** @type {string} */
        this._secret = generateId(16);
        /** @type {?string} */
        this._token = null;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {boolean} */
        this._eventListenersSetup = false;
    }

    /**
     * @returns {void}
     */
    signal() {
        if (!this._eventListenersSetup) {
            this._eventListeners.addEventListener(window, 'message', this._onMessage.bind(this), false);
            this._eventListenersSetup = true;
        }
        /** @type {import('frame-client').FrameEndpointReadyDetails} */
        const details = {secret: this._secret};
        void this._api.broadcastTab({action: 'frameEndpointReady', params: details});
    }

    /**
     * @param {unknown} message
     * @returns {boolean}
     */
    authenticate(message) {
        return (
            this._token !== null &&
            typeof message === 'object' && message !== null &&
            this._token === /** @type {import('core').SerializableObject} */ (message).token &&
            this._secret === /** @type {import('core').SerializableObject} */ (message).secret
        );
    }

    /**
     * @param {MessageEvent<unknown>} event
     */
    _onMessage(event) {
        if (this._token !== null) { return; } // Already initialized

        const {data} = event;
        if (typeof data !== 'object' || data === null) {
            log.error('Invalid message');
            return;
        }

        const {action} = /** @type {import('core').SerializableObject} */ (data);
        if (action !== 'frameEndpointConnect') {
            log.error('Invalid action');
            return;
        }

        const {params} = /** @type {import('core').SerializableObject} */ (data);
        if (typeof params !== 'object' || params === null) {
            log.error('Invalid data');
            return;
        }

        const {secret} = /** @type {import('core').SerializableObject} */ (params);
        if (secret !== this._secret) {
            log.error('Invalid authentication');
            return;
        }

        const {token, hostFrameId} = /** @type {import('core').SerializableObject} */ (params);
        if (typeof token !== 'string' || typeof hostFrameId !== 'number') {
            log.error('Invalid target');
            return;
        }

        this._token = token;

        this._eventListeners.removeAllEventListeners();
        /** @type {import('frame-client').FrameEndpointConnectedDetails} */
        const details = {secret, token};
        void this._api.sendMessageToFrame(hostFrameId, {action: 'frameEndpointConnected', params: details});
    }
}
