/*
 * Copyright (C) 2026  Yomitan Authors
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

const GSM_YOMITAN_API_REQUEST_EVENT_TYPE = 'gsm-yomitan-api-request';
const GSM_YOMITAN_API_RESPONSE_EVENT_TYPE = 'gsm-yomitan-api-response';

export class GsmYomitanApiBridge {
    /**
     * @param {import('../comm/api.js').API} api
     */
    constructor(api) {
        /** @type {import('../comm/api.js').API} */
        this._api = api;
        /** @type {(event: MessageEvent) => void} */
        this._onMessageBind = this._onMessage.bind(this);
    }

    /** */
    prepare() {
        window.addEventListener('message', this._onMessageBind, false);
    }

    /**
     * @param {MessageEvent} event
     */
    _onMessage(event) {
        const data = event?.data;
        if (typeof data !== 'object' || data === null) { return; }
        if (data.type !== GSM_YOMITAN_API_REQUEST_EVENT_TYPE) { return; }
        void this._handleRequest(data);
    }

    /**
     * @param {import('core').UnknownObject} data
     * @returns {Promise<void>}
     */
    async _handleRequest(data) {
        const {requestId} = data;
        if (typeof requestId !== 'number' && typeof requestId !== 'string') {
            return;
        }

        /** @type {{type: string, requestId: number|string, action: string, responseStatusCode: number, data: unknown, error: ?string}} */
        const responseMessage = {
            type: GSM_YOMITAN_API_RESPONSE_EVENT_TYPE,
            requestId,
            action: '',
            responseStatusCode: 500,
            data: null,
            error: null,
        };

        try {
            const action = data.action;
            if (typeof action !== 'string' || action.length === 0) {
                throw new Error('Invalid action');
            }
            responseMessage.action = action;

            const result = await this._api.gsmYomitanApiInvoke(action, data.body);
            responseMessage.data = result.data;
            responseMessage.responseStatusCode = Number.isFinite(result.responseStatusCode) ? result.responseStatusCode : 500;
        } catch (e) {
            const error = (e instanceof Error) ? e : new Error(String(e));
            responseMessage.error = error.message;
            responseMessage.responseStatusCode = 500;
        }

        window.postMessage(responseMessage, '*');
    }
}
