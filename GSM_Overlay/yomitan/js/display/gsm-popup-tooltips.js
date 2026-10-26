/*
 * Copyright (C) 2023-2026  Yomitan Authors
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
 * Keep native title tooltips from following Magpie's source-space cursor.
 * This runs independently of text scanning, including when scanning is disabled.
 */
export function prepareGsmPopupTooltips() {
    if (window === window.top || !/Electron\//.test(navigator.userAgent)) { return; }

    const root = document.documentElement;
    let receivedState = false;
    // A new frame can render under the physical cursor before the first reply.
    root.toggleAttribute('data-gsm-magpie-captured', true);
    window.addEventListener('message', (/** @type {MessageEvent<unknown>} */ event) => {
        if (event.source !== window.top) { return; }
        const data = /** @type {{type?: unknown, captured?: unknown}|null} */ (event.data);
        if (data?.type !== 'gsm-magpie-pointer-state' || typeof data.captured !== 'boolean') { return; }
        receivedState = true;
        root.toggleAttribute('data-gsm-magpie-captured', data.captured);
    });
    window.top?.postMessage({type: 'gsm-magpie-pointer-state-request'}, '*');
    // Other Electron hosts have no GSM bridge. Match the scanner's fallback.
    setTimeout(() => {
        if (!receivedState) { root.toggleAttribute('data-gsm-magpie-captured', false); }
    }, 1000);
}
