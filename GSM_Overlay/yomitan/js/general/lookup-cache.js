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

import {parseJson} from '../core/json.js';

/** Bounded, profile-scoped JSON results with concurrent request sharing. */
export class LookupCache {
    /**
     * @param {number} [maxEntries]
     * @param {number} [maxBytes]
     */
    constructor(maxEntries = 128, maxBytes = 8 * 1024 * 1024) {
        /** @type {number} */
        this._maxEntries = maxEntries;
        /** @type {number} */
        this._maxBytes = maxBytes;
        /** @type {Map<string, {serialized: string, bytes: number}>} */
        this._entries = new Map();
        /** @type {Map<string, Promise<string>>} */
        this._pending = new Map();
        /** @type {WeakMap<object, number>} */
        this._scopes = new WeakMap();
        /** @type {number} */
        this._nextScope = 0;
        /** @type {number} */
        this._bytes = 0;
        /** @type {number} */
        this._revision = 0;
    }

    /** Invalidate both completed and unfinished lookups after settings/database changes. */
    clear() {
        this._entries.clear();
        this._pending.clear();
        this._scopes = new WeakMap();
        this._nextScope = 0;
        this._bytes = 0;
        ++this._revision;
    }

    /**
     * @template T
     * @param {object} scope Resolved profile options, including contextual profiles.
     * @param {string} query Complete lookup arguments.
     * @param {() => Promise<T>} load
     * @returns {Promise<T>}
     */
    async get(scope, query, load) {
        let scopeId = this._scopes.get(scope);
        if (typeof scopeId === 'undefined') {
            scopeId = ++this._nextScope;
            this._scopes.set(scope, scopeId);
        }
        const key = `${scopeId}:${query}`;
        const cached = this._entries.get(key);
        if (typeof cached !== 'undefined') {
            this._entries.delete(key);
            this._entries.set(key, cached);
            return parseJson(cached.serialized);
        }
        const pending = this._pending.get(key);
        if (typeof pending !== 'undefined') { return parseJson(await pending); }
        // Do not build another unbounded queue if callers flood distinct requests.
        if (this._pending.size >= this._maxEntries) { return load(); }
        const revision = this._revision;
        const result = Promise.resolve().then(load);
        const job = result.then((value) => JSON.stringify(value));
        this._pending.set(key, job);
        try {
            const json = await job;
            const bytes = (key.length + json.length) * 2;
            if (revision === this._revision && this._maxEntries > 0 && bytes <= this._maxBytes) {
                while (this._entries.size >= this._maxEntries || this._bytes + bytes > this._maxBytes) {
                    const oldest = this._entries.entries().next().value;
                    if (typeof oldest === 'undefined') { break; }
                    this._bytes -= oldest[1].bytes;
                    this._entries.delete(oldest[0]);
                }
                this._entries.set(key, {serialized: json, bytes});
                this._bytes += bytes;
            }
            // The first caller can use its own result without an extra parse.
            // Shared/repeated callers receive independent copies from the JSON.
            return await result;
        } finally {
            if (this._pending.get(key) === job) { this._pending.delete(key); }
        }
    }
}
