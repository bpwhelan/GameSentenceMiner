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

import {removeSyriacScriptDiacritics} from './aii/assyrian-neo-aramaic-text-preprocessors.js';
import {
    addHamzaBottom,
    addHamzaTop,
    convertAlifMaqsuraToYaa,
    convertHaToTaMarbuta,
    normalizeUnicode,
    removeArabicScriptDiacritics,
    removeTatweel,
} from './ar/arabic-text-preprocessors.js';
import {arabicTransforms} from './ar/arabic-transforms.js';
import {normalizeRadicalCharacters} from './CJK-util.js';
import {eszettPreprocessor} from './de/german-text-preprocessors.js';
import {germanTransforms} from './de/german-transforms.js';
import {removeDoubleAcuteAccents} from './el/modern-greek-processors.js';
import {englishTransforms} from './en/english-transforms.js';
import {esperantoTransforms} from './eo/esperanto-transforms.js';
import {spanishTransforms} from './es/spanish-transforms.js';
import {apostropheVariants} from './fr/french-text-preprocessors.js';
import {frenchTransforms} from './fr/french-transforms.js';
import {irishTransforms} from './ga/irish-transforms.js';
import {convertLatinToGreek} from './grc/ancient-greek-processors.js';
import {ancientGreekTransforms} from './grc/ancient-greek-transforms.js';
import {
    alphabeticToHiragana,
    alphanumericWidthVariants,
    collapseEmphaticSequences,
    convertHalfWidthCharacters,
    convertHiraganaToKatakana,
    normalizeCJKCompatibilityCharacters,
    normalizeCombiningCharacters,
    standardizeKanji,
} from './ja/japanese-text-preprocessors.js';
import {japaneseTransforms} from './ja/japanese-transforms.js';
import {isStringPartiallyJapanese} from './ja/japanese.js';
import {georgianTransforms} from './ka/georgian-transforms.js';
import {disassembleHangul, reassembleHangul} from './ko/korean-text-processors.js';
import {koreanTransforms} from './ko/korean-transforms.js';
import {processDiphtongs} from './la/latin-text-preprocessors.js';
import {latinTransforms} from './la/latin-transforms.js';
import {removeRussianDiacritics, yoToE} from './ru/russian-text-preprocessors.js';
import {oldIrishTransforms} from './sga/old-irish-transforms.js';
import {removeSerboCroatianAccentMarks} from './sh/serbo-croatian-text-preprocessors.js';
import {albanianTransforms} from './sq/albanian-transforms.js';
import {capitalizeFirstLetter, decapitalize, removeAlphabeticDiacritics} from './text-processors.js';
import {tagalogTransforms} from './tl/tagalog-transforms.js';
import {normalizeDiacritics} from './vi/viet-text-preprocessors.js';
import {convertFinalLetters, convertYiddishLigatures} from './yi/yiddish-text-postprocessors.js';
import {combineYiddishLigatures, removeYiddishDiacritics} from './yi/yiddish-text-preprocessors.js';
import {yiddishTransforms} from './yi/yiddish-transforms.js';
import {isStringPartiallyChinese, normalizePinyin} from './zh/chinese.js';

const capitalizationPreprocessors = {
    decapitalize,
    capitalizeFirstLetter,
};

/** @type {import('language-descriptors').LanguageDescriptorAny[]} */
const languageDescriptors = [
    {
        iso: 'aii',
        iso639_3: 'aii',
        name: 'Assyrian Neo-Aramaic',
        exampleText: 'ܟܵܬܹܒ݂',
        textPreprocessors: {
            removeSyriacScriptDiacritics,
        },
    },
    {
        iso: 'ar',
        iso639_3: 'ara',
        name: 'Arabic (MSA)',
        exampleText: 'قَرَأَ',
        textPreprocessors: {
            removeArabicScriptDiacritics,
            removeTatweel,
            normalizeUnicode,
            addHamzaTop,
            addHamzaBottom,
            convertAlifMaqsuraToYaa,
        },
        languageTransforms: arabicTransforms,
    },
    {
        iso: 'arz',
        iso639_3: 'arz',
        name: 'Arabic (Egyptian)',
        exampleText: 'قَرَأَ',
        textPreprocessors: {
            removeArabicScriptDiacritics,
            removeTatweel,
            normalizeUnicode,
            addHamzaTop,
            addHamzaBottom,
            convertAlifMaqsuraToYaa,
            convertHaToTaMarbuta,
        },
        languageTransforms: arabicTransforms,
    },
    {
        iso: 'bg',
        iso639_3: 'bul',
        name: 'Bulgarian',
        exampleText: 'чета',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'cs',
        iso639_3: 'ces',
        name: 'Czech',
        exampleText: 'číst',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'da',
        iso639_3: 'dan',
        name: 'Danish',
        exampleText: 'læse',
        textPreprocessors: {
            ...capitalizationPreprocessors,
        },
    },
    {
        iso: 'de',
        iso639_3: 'deu',
        name: 'German',
        exampleText: 'lesen',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            eszettPreprocessor,
        },
        languageTransforms: germanTransforms,
    },
    {
        iso: 'el',
        iso639_3: 'ell',
        name: 'Greek',
        exampleText: 'διαβάζω',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeDoubleAcuteAccents,
        },
    },
    {
        iso: 'en',
        iso639_3: 'eng',
        name: 'English',
        exampleText: 'read',
        textPreprocessors: capitalizationPreprocessors,
        languageTransforms: englishTransforms,
    },
    {
        iso: 'eo',
        iso639_3: 'epo',
        name: 'Esperanto',
        exampleText: 'legi',
        textPreprocessors: capitalizationPreprocessors,
        languageTransforms: esperantoTransforms,
    },
    {
        iso: 'es',
        iso639_3: 'spa',
        name: 'Spanish',
        exampleText: 'leer',
        textPreprocessors: capitalizationPreprocessors,
        languageTransforms: spanishTransforms,
    },
    {
        iso: 'et',
        iso639_3: 'est',
        name: 'Estonian',
        exampleText: 'lugema',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'fa',
        iso639_3: 'fas',
        name: 'Persian',
        exampleText: 'خواندن',
        textPreprocessors: {
            removeArabicScriptDiacritics,
        },
    },
    {
        iso: 'fi',
        iso639_3: 'fin',
        name: 'Finnish',
        exampleText: 'lukea',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'fr',
        iso639_3: 'fra',
        name: 'French',
        exampleText: 'lire',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            apostropheVariants,
        },
        languageTransforms: frenchTransforms,
    },
    {
        iso: 'ga',
        iso639_3: 'gle',
        name: 'Irish',
        exampleText: 'léigh',
        textPreprocessors: capitalizationPreprocessors,
        languageTransforms: irishTransforms,
    },
    {
        iso: 'grc',
        iso639_3: 'grc',
        name: 'Ancient Greek',
        exampleText: 'γράφω', /* 'to write' */
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeAlphabeticDiacritics,
            convertLatinToGreek,
        },
        languageTransforms: ancientGreekTransforms,
    },
    {
        // no 2 letter iso for hawaiian
        iso: 'haw',
        iso639_3: 'haw',
        name: 'Hawaiian',
        exampleText: 'heluhelu',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'he',
        iso639_3: 'heb',
        name: 'Hebrew',
        exampleText: 'קריאה',
    },
    {
        iso: 'hi',
        iso639_3: 'hin',
        name: 'Hindi',
        exampleText: 'पढ़ने के लिए',
    },
    {
        iso: 'hu',
        iso639_3: 'hun',
        name: 'Hungarian',
        exampleText: 'olvasni',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'id',
        iso639_3: 'ind',
        name: 'Indonesian',
        exampleText: 'baca',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeAlphabeticDiacritics,
        },
    },
    {
        iso: 'it',
        iso639_3: 'ita',
        name: 'Italian',
        exampleText: 'leggere',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeAlphabeticDiacritics,
        },
    },
    {
        iso: 'la',
        iso639_3: 'lat',
        name: 'Latin',
        exampleText: 'legō',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeAlphabeticDiacritics,
            processDiphtongs,
        },
        languageTransforms: latinTransforms,
    },
    {
        iso: 'lo',
        iso639_3: 'lao',
        name: 'Lao',
        exampleText: 'ອ່ານ',
    },
    {
        iso: 'lv',
        iso639_3: 'lav',
        name: 'Latvian',
        exampleText: 'lasīt',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'ja',
        iso639_3: 'jpn',
        name: 'Japanese',
        exampleText: '読め',
        isTextLookupWorthy: isStringPartiallyJapanese,
        textPreprocessors: {
            convertHalfWidthCharacters,
            alphabeticToHiragana,
            normalizeCombiningCharacters,
            normalizeCJKCompatibilityCharacters,
            normalizeRadicalCharacters,
            alphanumericWidthVariants,
            convertHiraganaToKatakana,
            collapseEmphaticSequences,
            standardizeKanji,
        },
        languageTransforms: japaneseTransforms,
    },
    {
        iso: 'ka',
        iso639_3: 'kat',
        name: 'Georgian',
        exampleText: 'კითხვა', // Georgian for “read”
        languageTransforms: georgianTransforms,
    },
    {
        iso: 'kn',
        iso639_3: 'kan',
        name: 'Kannada',
        exampleText: 'ಓದು',
    },
    {
        iso: 'km',
        iso639_3: 'khm',
        name: 'Khmer',
        exampleText: 'អាន',
    },
    {
        iso: 'ko',
        iso639_3: 'kor',
        name: 'Korean',
        exampleText: '읽어',
        textPreprocessors: {
            disassembleHangul,
        },
        textPostprocessors: {
            reassembleHangul,
        },
        languageTransforms: koreanTransforms,
    },
    {
        iso: 'mn',
        iso639_3: 'mon',
        name: 'Mongolian',
        exampleText: 'унших',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'mt',
        iso639_3: 'mlt',
        name: 'Maltese',
        exampleText: 'kiteb',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'nl',
        iso639_3: 'nld',
        name: 'Dutch',
        exampleText: 'lezen',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'no',
        iso639_3: 'nor',
        name: 'Norwegian',
        exampleText: 'lese',
        textPreprocessors: {
            ...capitalizationPreprocessors,
        },
    },
    {
        iso: 'pl',
        iso639_3: 'pol',
        name: 'Polish',
        exampleText: 'czytać',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'pt',
        iso639_3: 'por',
        name: 'Portuguese',
        exampleText: 'ler',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'ro',
        iso639_3: 'ron',
        name: 'Romanian',
        exampleText: 'citi',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeAlphabeticDiacritics,
        },
    },
    {
        iso: 'ru',
        iso639_3: 'rus',
        name: 'Russian',
        exampleText: 'читать',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            yoToE,
            removeRussianDiacritics,
        },
    },
    {
        iso: 'sga',
        iso639_3: 'sga',
        name: 'Old Irish',
        exampleText: 'légaid',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeAlphabeticDiacritics,
        },
        languageTransforms: oldIrishTransforms,
    },
    {
        iso: 'sh',
        iso639_3: 'hbs',
        name: 'Serbo-Croatian',
        exampleText: 'čìtati',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeSerboCroatianAccentMarks,
        },
    },
    {
        iso: 'sq',
        iso639_3: 'sqi',
        name: 'Albanian',
        exampleText: 'ndihmoj', /* 'to help' */
        textPreprocessors: capitalizationPreprocessors,
        languageTransforms: albanianTransforms,
    },
    {
        iso: 'sv',
        iso639_3: 'swe',
        name: 'Swedish',
        exampleText: 'läsa',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'th',
        iso639_3: 'tha',
        name: 'Thai',
        exampleText: 'อ่าน',
    },
    {
        iso: 'tl',
        iso639_3: 'tgl',
        name: 'Tagalog',
        exampleText: 'basahin',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            removeAlphabeticDiacritics,
        },
        languageTransforms: tagalogTransforms,
    },
    {
        iso: 'tr',
        iso639_3: 'tur',
        name: 'Turkish',
        exampleText: 'okumak',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'tok',
        iso639_3: 'tok',
        name: 'Toki Pona',
        exampleText: 'wile',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'uk',
        iso639_3: 'ukr',
        name: 'Ukrainian',
        exampleText: 'читати',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'vi',
        iso639_3: 'vie',
        name: 'Vietnamese',
        exampleText: 'đọc',
        textPreprocessors: {
            ...capitalizationPreprocessors,
            normalizeDiacritics,
        },
    },
    {
        iso: 'cy',
        iso639_3: 'cym',
        name: 'Welsh',
        exampleText: 'ddarllen',
        textPreprocessors: capitalizationPreprocessors,
    },
    {
        iso: 'yi',
        iso639_3: 'yid',
        name: 'Yiddish',
        exampleText: 'באַשאַפֿן',
        textPreprocessors: {
            removeYiddishDiacritics,
            combineYiddishLigatures,
        },
        textPostprocessors: {
            convertFinalLetters,
            convertYiddishLigatures,
        },
        languageTransforms: yiddishTransforms,
    },
    {
        iso: 'yue',
        iso639_3: 'yue',
        name: 'Cantonese',
        exampleText: '讀',
        textPreprocessors: {
            normalizeRadicalCharacters,
        },
    },
    {
        iso: 'zh',
        iso639_3: 'zho',
        name: 'Chinese',
        exampleText: '读',
        isTextLookupWorthy: isStringPartiallyChinese,
        readingNormalizer: normalizePinyin,
        textPreprocessors: {
            normalizeRadicalCharacters,
        },
    },
];

/** @type {Map<string, import('language-descriptors').LanguageDescriptorAny>} */
export const languageDescriptorMap = new Map();
for (const languageDescriptor of languageDescriptors) {
    languageDescriptorMap.set(languageDescriptor.iso, languageDescriptor);
}
