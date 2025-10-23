/*
 * Copyright (C) 2024-2025  Yomitan Authors
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

const ligatures = [
    {lig: '\u05f0', split: '\u05d5' + '\u05d5'}, // װ -> וו
    {lig: '\u05f1', split: '\u05d5' + '\u05d9'}, // ױ -> וי
    {lig: '\u05f2', split: '\u05d9' + '\u05d9'}, // ײ -> יי
    {lig: '\ufb1d', split: '\u05d9' + '\u05b4'}, // יִ -> יִ
    {lig: '\ufb1f', split: '\u05d9' + '\u05d9' + '\u05b7'}, // ײַ -> ייַ
    {lig: '\ufb2e', split: '\u05d0' + '\u05b7'}, // Pasekh alef
    {lig: '\ufb2f', split: '\u05d0' + '\u05b8'}, // Komets alef
];

/** @type {import('language').TextProcessor<boolean>} */
export const combineYiddishLigatures = {
    name: 'Combine Ligatures',
    description: 'וו → װ',
    options: [true],
    process: (str) => {
        for (const ligature of ligatures) {
            str = str.replace(ligature.split, ligature.lig);
        }
        return str;
    },
};

/** @type {import('language').TextProcessor<boolean>} */
export const removeYiddishDiacritics = {
    name: 'Remove Diacritics',
    description: 'פאת → פֿאָתּ',
    options: [true],
    process: (str) => {
        return str.replace(/[\u05B0-\u05C7]/g, '');
    },
};
