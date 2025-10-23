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

import {isObjectNotArray} from '../core/object-utilities.js';

/** @type {RegExp} @readonly */
const markerPattern = /\{([\p{Letter}\p{Number}_-]+)\}/gu;

/**
 * Gets the root deck name of a full deck name. If the deck is a root deck,
 * the same name is returned. Nested decks are separated using '::'.
 * @param {string} deckName A string of the deck name.
 * @returns {string} A string corresponding to the name of the root deck.
 */
export function getRootDeckName(deckName) {
    const index = deckName.indexOf('::');
    return index >= 0 ? deckName.substring(0, index) : deckName;
}

/**
 * Checks whether or not any marker is contained in a string.
 * @param {string} string A string to check.
 * @returns {boolean} `true` if the text contains an Anki field marker, `false` otherwise.
 */
export function stringContainsAnyFieldMarker(string) {
    const result = markerPattern.test(string);
    markerPattern.lastIndex = 0;
    return result;
}

/**
 * Gets a list of all markers that are contained in a string.
 * @param {string} string A string to check.
 * @returns {string[]} An array of marker strings.
 */
export function getFieldMarkers(string) {
    const pattern = markerPattern;
    const markers = [];
    while (true) {
        const match = pattern.exec(string);
        if (match === null) { break; }
        markers.push(match[1]);
    }
    return markers;
}

/**
 * Returns a regular expression which can be used to find markers in a string.
 * @param {boolean} global Whether or not the regular expression should have the global flag.
 * @returns {RegExp} A new `RegExp` instance.
 */
export function cloneFieldMarkerPattern(global) {
    return new RegExp(markerPattern.source, global ? 'gu' : 'u');
}

/**
 * Checks whether or not a note object is valid.
 * @param {import('anki').Note} note A note object to check.
 * @returns {boolean} `true` if the note is valid, `false` otherwise.
 */
export function isNoteDataValid(note) {
    if (!isObjectNotArray(note)) { return false; }
    const {fields, deckName, modelName} = note;
    return (
        typeof deckName === 'string' && deckName.length > 0 &&
        typeof modelName === 'string' && modelName.length > 0 &&
        Object.entries(fields).length > 0
    );
}

export const INVALID_NOTE_ID = -1;


/**
 * @param {string} prefix
 * @param {string} extension
 * @param {number} timestamp
 * @returns {string}
 */
export function generateAnkiNoteMediaFileName(prefix, extension, timestamp) {
    let fileName = prefix;

    fileName += `_${ankNoteDateToString(new Date(timestamp))}`;
    fileName += extension;

    fileName = replaceInvalidFileNameCharacters(fileName);

    return fileName;
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function replaceInvalidFileNameCharacters(fileName) {
    // eslint-disable-next-line no-control-regex
    return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
}

/**
 * @param {Date} date
 * @returns {string}
 */
function ankNoteDateToString(date) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth().toString().padStart(2, '0');
    const day = date.getUTCDate().toString().padStart(2, '0');
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const seconds = date.getUTCSeconds().toString().padStart(2, '0');
    const milliseconds = date.getUTCMilliseconds().toString().padStart(3, '0');
    return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}-${milliseconds}`;
}
