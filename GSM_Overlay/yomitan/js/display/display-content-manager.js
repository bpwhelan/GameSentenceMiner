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
import {base64ToArrayBuffer} from '../data/array-buffer-util.js';

/**
 * The content manager which is used when generating HTML display content.
 */
export class DisplayContentManager {
    /**
     * Creates a new instance of the class.
     * @param {import('./display.js').Display} display The display instance that owns this object.
     */
    constructor(display) {
        /** @type {import('./display.js').Display} */
        this._display = display;
        /** @type {import('core').TokenObject} */
        this._token = {};
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {import('display-content-manager').LoadMediaRequest[]} */
        this._loadMediaRequests = [];
    }

    /** @type {import('display-content-manager').LoadMediaRequest[]} */
    get loadMediaRequests() {
        return this._loadMediaRequests;
    }

    /**
     * Queues loading media file from a given dictionary.
     * @param {string} path
     * @param {string} dictionary
     * @param {HTMLImageElement|HTMLCanvasElement} element
     */
    loadMedia(path, dictionary, element) {
        this._loadMediaRequests.push({path, dictionary, element});
    }

    /**
     * Unloads all media that has been loaded.
     */
    unloadAll() {
        this._token = {};

        this._eventListeners.removeAllEventListeners();

        this._loadMediaRequests = [];
    }

    /**
     * Sets up attributes and events for a link element.
     * @param {HTMLAnchorElement} element The link element.
     * @param {string} href The URL.
     * @param {boolean} internal Whether or not the URL is an internal or external link.
     */
    prepareLink(element, href, internal) {
        element.href = href;
        if (!internal) {
            element.target = '_blank';
            element.rel = 'noreferrer noopener';
        }
        this._eventListeners.addEventListener(element, 'click', this._onLinkClick.bind(this));
    }

    /**
     * Execute media requests
     */
    async executeMediaRequests() {
        // Radical fix: Load images directly as blob URLs instead of using canvas
        console.log(`[DisplayContentManager] Executing ${this._loadMediaRequests.length} media requests`);
        
        for (const {path, dictionary, element} of this._loadMediaRequests) {
            try {
                console.log(`[DisplayContentManager] Loading media: path=${path}, dictionary=${dictionary}`);
                const data = await this._display.application.api.getMedia([{path, dictionary}]);
                
                if (data && data.length > 0 && data[0].content) {
                    console.log(`[DisplayContentManager] Media data received, type=${data[0].mediaType}`);
                    const buffer = base64ToArrayBuffer(data[0].content);
                    const blob = new Blob([buffer], {type: data[0].mediaType});
                    const blobUrl = URL.createObjectURL(blob);
                    console.log(`[DisplayContentManager] Created blob URL: ${blobUrl}`);
                    
                    if (element instanceof HTMLImageElement) {
                        // Force display immediately
                        element.style.display = 'inline-block';
                        element.style.visibility = 'visible';
                        element.style.opacity = '1';
                        
                        element.onload = () => {
                            console.log(`[DisplayContentManager] Image loaded successfully: ${path}`);
                            const link = element.closest('.gloss-image-link');
                            if (link) {
                                link.dataset.imageLoadState = 'loaded';
                                link.dataset.hasImage = 'true';
                            }
                        };
                        element.onerror = (e) => {
                            console.error(`[DisplayContentManager] Image load error:`, e, path);
                            const link = element.closest('.gloss-image-link');
                            if (link) {
                                link.dataset.imageLoadState = 'load-error';
                            }
                        };
                        
                        // Set src last to trigger load
                        element.src = blobUrl;
                        
                    } else if (element instanceof HTMLCanvasElement) {
                        // Fallback for canvas elements
                        const img = new Image();
                        img.onload = () => {
                            console.log(`[DisplayContentManager] Canvas image loaded: ${path}`);
                            const ctx = element.getContext('2d');
                            if (ctx) {
                                element.width = img.naturalWidth || element.width;
                                element.height = img.naturalHeight || element.height;
                                ctx.drawImage(img, 0, 0, element.width, element.height);
                                const link = element.closest('.gloss-image-link');
                                if (link) {
                                    link.dataset.imageLoadState = 'loaded';
                                    link.dataset.hasImage = 'true';
                                }
                            }
                            URL.revokeObjectURL(blobUrl);
                        };
                        img.onerror = (e) => {
                            console.error(`[DisplayContentManager] Canvas image error:`, e, path);
                            const link = element.closest('.gloss-image-link');
                            if (link) {
                                link.dataset.imageLoadState = 'load-error';
                            }
                            URL.revokeObjectURL(blobUrl);
                        };
                        img.src = blobUrl;
                    }
                } else {
                    console.error(`[DisplayContentManager] No media data received for ${path}`);
                }
            } catch (error) {
                console.error('[DisplayContentManager] Failed to load media:', error, path, dictionary);
                const link = element.closest('.gloss-image-link');
                if (link) {
                    link.dataset.imageLoadState = 'load-error';
                }
            }
        }
        this._loadMediaRequests = [];
    }

    /**
     * @param {string} path
     * @param {string} dictionary
     * @param {Window} window
     */
    async openMediaInTab(path, dictionary, window) {
        const data = await this._display.application.api.getMedia([{path, dictionary}]);
        const buffer = base64ToArrayBuffer(data[0].content);
        const blob = new Blob([buffer], {type: data[0].mediaType});
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank')?.focus();
    }

    /**
     * @param {MouseEvent} e
     */
    _onLinkClick(e) {
        const {href} = /** @type {HTMLAnchorElement} */ (e.currentTarget);
        if (typeof href !== 'string') { return; }

        const baseUrl = new URL(location.href);
        const url = new URL(href, baseUrl);
        const internal = (url.protocol === baseUrl.protocol && url.host === baseUrl.host);
        if (!internal) { return; }

        e.preventDefault();

        /** @type {import('display').HistoryParams} */
        const params = {};
        for (const [key, value] of url.searchParams.entries()) {
            params[key] = value;
        }
        this._display.setContent({
            historyMode: 'new',
            focus: false,
            params,
            state: null,
            content: null,
        });
    }
}
