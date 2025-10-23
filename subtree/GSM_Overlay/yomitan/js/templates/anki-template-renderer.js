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

import {Handlebars} from '../../lib/handlebars.js';
import {NodeFilter} from '../../lib/linkedom.js';
import {createAnkiNoteData} from '../data/anki-note-data-creator.js';
import {getPronunciationsOfType, isNonNounVerbOrAdjective} from '../dictionary/dictionary-data-util.js';
import {PronunciationGenerator} from '../display/pronunciation-generator.js';
import {StructuredContentGenerator} from '../display/structured-content-generator.js';
import {CssStyleApplier} from '../dom/css-style-applier.js';
import {convertHiraganaToKatakana, convertKatakanaToHiragana, distributeFurigana, getKanaMorae, getPitchCategory, isMoraPitchHigh} from '../language/ja/japanese.js';
import {AnkiTemplateRendererContentManager} from './anki-template-renderer-content-manager.js';
import {TemplateRendererMediaProvider} from './template-renderer-media-provider.js';
import {TemplateRenderer} from './template-renderer.js';

/**
 * This class contains all Anki-specific template rendering functionality. It is built on
 * the generic TemplateRenderer class and various other Anki-related classes.
 */
export class AnkiTemplateRenderer {
    /**
     * Creates a new instance of the class.
     * @param {Document} document
     * @param {Window} window
     */
    constructor(document, window) {
        /** @type {CssStyleApplier} */
        this._structuredContentStyleApplier = new CssStyleApplier('/data/structured-content-style.json');
        /** @type {CssStyleApplier} */
        this._pronunciationStyleApplier = new CssStyleApplier('/data/pronunciation-style.json');
        /** @type {RegExp} */
        this._structuredContentDatasetKeyIgnorePattern = /^sc([^a-z]|$)/;
        /** @type {TemplateRenderer} */
        this._templateRenderer = new TemplateRenderer();
        /** @type {TemplateRendererMediaProvider} */
        this._mediaProvider = new TemplateRendererMediaProvider();
        /** @type {?(Map<string, unknown>[])} */
        this._stateStack = null;
        /** @type {?import('anki-note-builder').Requirement[]} */
        this._requirements = null;
        /** @type {(() => void)[]} */
        this._cleanupCallbacks = [];
        /** @type {?HTMLElement} */
        this._temporaryElement = null;
        /** @type {Document} */
        this._document = document;
        /** @type {Window} */
        this._window = window;
        /** @type {PronunciationGenerator} */
        this._pronunciationGenerator = new PronunciationGenerator(this._document);
    }

    /**
     * Gets the generic TemplateRenderer instance.
     * @type {TemplateRenderer}
     */
    get templateRenderer() {
        return this._templateRenderer;
    }

    /**
     * Prepares the data that is necessary before the template renderer can be safely used.
     */
    async prepare() {
        /* eslint-disable @stylistic/no-multi-spaces */
        this._templateRenderer.registerHelpers([
            ['dumpObject',       this._dumpObject.bind(this)],
            ['furigana',         this._furigana.bind(this)],
            ['furiganaPlain',    this._furiganaPlain.bind(this)],
            ['multiLine',        this._multiLine.bind(this)],
            ['regexReplace',     this._regexReplace.bind(this)],
            ['regexMatch',       this._regexMatch.bind(this)],
            ['mergeTags',        this._mergeTags.bind(this)],
            ['eachUpTo',         this._eachUpTo.bind(this)],
            ['spread',           this._spread.bind(this)],
            ['op',               this._op.bind(this)],
            ['get',              this._get.bind(this)],
            ['set',              this._set.bind(this)],
            ['scope',            this._scope.bind(this)],
            ['property',         this._property.bind(this)],
            ['noop',             this._noop.bind(this)],
            ['isMoraPitchHigh',  this._isMoraPitchHigh.bind(this)],
            ['getKanaMorae',     this._getKanaMorae.bind(this)],
            ['typeof',           this._getTypeof.bind(this)],
            ['join',             this._join.bind(this)],
            ['concat',           this._concat.bind(this)],
            ['pitchCategories',  this._pitchCategories.bind(this)],
            ['formatGlossary',   this._formatGlossary.bind(this)],
            ['formatGlossaryPlain', this._formatGlossaryPlain.bind(this)],
            ['hasMedia',         this._hasMedia.bind(this)],
            ['getMedia',         this._getMedia.bind(this)],
            ['pronunciation',    this._pronunciation.bind(this)],
            ['hiragana',         this._hiragana.bind(this)],
            ['katakana',         this._katakana.bind(this)],
        ]);
        /* eslint-enable @stylistic/no-multi-spaces */
        this._templateRenderer.registerDataType('ankiNote', {
            modifier: ({marker, commonData}) => createAnkiNoteData(marker, commonData),
            composeData: ({marker}, commonData) => ({marker, commonData}),
        });
        this._templateRenderer.setRenderCallbacks(
            this._onRenderSetup.bind(this),
            this._onRenderCleanup.bind(this),
        );
        await Promise.all([
            this._structuredContentStyleApplier.prepare(),
            this._pronunciationStyleApplier.prepare(),
        ]);
    }

    // Private

    /**
     * @returns {{requirements: import('anki-note-builder').Requirement[]}}
     */
    _onRenderSetup() {
        /** @type {import('anki-note-builder').Requirement[]} */
        const requirements = [];
        this._stateStack = [new Map()];
        this._requirements = requirements;
        this._mediaProvider.requirements = requirements;
        return {requirements};
    }

    /**
     * @returns {void}
     */
    _onRenderCleanup() {
        for (const callback of this._cleanupCallbacks) { callback(); }
        this._stateStack = null;
        this._requirements = null;
        this._mediaProvider.requirements = null;
        this._cleanupCallbacks.length = 0;
    }

    /**
     * @param {string} text
     * @returns {string}
     */
    _safeString(text) {
        return new Handlebars.SafeString(text);
    }

    // Template helpers

    /** @type {import('template-renderer').HelperFunction<string>} */
    _dumpObject(object) {
        return JSON.stringify(object, null, 4);
    }

    /** @type {import('template-renderer').HelperFunction<string>} */
    _furigana(args, context, options) {
        const {expression, reading} = this._getFuriganaExpressionAndReading(args, context, options);
        const segments = distributeFurigana(expression, reading);

        let result = '';
        for (const {text, reading: reading2} of segments) {
            result += (
                reading2.length > 0 ?
                `<ruby>${text}<rt>${reading2}</rt></ruby>` :
                text
            );
        }

        return this._safeString(result);
    }

    /** @type {import('template-renderer').HelperFunction<string>} */
    _furiganaPlain(args, context, options) {
        const {expression, reading} = this._getFuriganaExpressionAndReading(args, context, options);
        const segments = distributeFurigana(expression, reading);

        let result = '';
        for (const {text, reading: reading2} of segments) {
            if (reading2.length > 0) {
                if (result.length > 0) { result += ' '; }
                result += `${text}[${reading2}]`;
            } else {
                result += text;
            }
        }

        return result;
    }

    /**
     * @type {import('template-renderer').HelperFunction<{expression: string, reading: string}>}
     */
    _getFuriganaExpressionAndReading(args) {
        let expression;
        let reading;
        if (args.length >= 2) {
            [expression, reading] = /** @type {[expression?: string, reading?: string]} */ (args);
        } else {
            ({expression, reading} = /** @type {import('core').SerializableObject} */ (args[0]));
        }
        return {
            expression: typeof expression === 'string' ? expression : '',
            reading: typeof reading === 'string' ? reading : '',
        };
    }

    /**
     * @param {string} string
     * @returns {string}
     */
    _stringToMultiLineHtml(string) {
        return string.split('\n').join('<br>');
    }

    /** @type {import('template-renderer').HelperFunction<string>} */
    _multiLine(_args, context, options) {
        return this._stringToMultiLineHtml(this._computeValueString(options, context));
    }

    /**
     * Usage:
     * ```{{#regexReplace regex string [flags] [content]...}}content{{/regexReplace}}```
     * - regex: regular expression string
     * - string: string to replace
     * - flags: optional flags for regular expression.
     * e.g. "i" for case-insensitive, "g" for replace all
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _regexReplace(args, context, options) {
        const argCount = args.length;
        let value = this._computeValueString(options, context);
        if (argCount > 3) {
            value = `${args.slice(3).join('')}${value}`;
        }
        if (argCount > 1) {
            try {
                const [pattern, replacement, flags] = args;
                if (typeof pattern !== 'string') { throw new Error('Invalid pattern'); }
                if (typeof replacement !== 'string') { throw new Error('Invalid replacement'); }
                const regex = new RegExp(pattern, typeof flags === 'string' ? flags : 'g');
                value = value.replace(regex, replacement);
            } catch (e) {
                return `${e}`;
            }
        }
        return value;
    }

    /**
     * Usage:
     * {{#regexMatch regex [flags] [content]...}}content{{/regexMatch}}
     * - regex: regular expression string
     * - flags: optional flags for regular expression
     * e.g. "i" for case-insensitive, "g" for match all
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _regexMatch(args, context, options) {
        const argCount = args.length;
        let value = this._computeValueString(options, context);
        if (argCount > 2) {
            value = `${args.slice(2).join('')}${value}`;
        }
        if (argCount > 0) {
            try {
                const [pattern, flags] = args;
                if (typeof pattern !== 'string') { throw new Error('Invalid pattern'); }
                const regex = new RegExp(pattern, typeof flags === 'string' ? flags : '');
                /** @type {string[]} */
                const parts = [];
                value.replace(regex, (g0) => {
                    parts.push(g0);
                    return g0;
                });
                value = parts.join('');
            } catch (e) {
                return `${e}`;
            }
        }
        return value;
    }

    /**
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _mergeTags(args) {
        const [object, isGroupMode, isMergeMode] = /** @type {[object: import('anki-templates').TermDictionaryEntry, isGroupMode: boolean, isMergeMode: boolean]} */ (args);
        /** @type {import('anki-templates').Tag[][]} */
        const tagSources = [];
        if (Array.isArray(object.termTags)) {
            tagSources.push(object.termTags);
        }
        if (isGroupMode || isMergeMode) {
            const {definitions} = object;
            if (Array.isArray(definitions)) {
                for (const definition of definitions) {
                    tagSources.push(definition.definitionTags);
                }
            }
        } else {
            if (Array.isArray(object.definitionTags)) {
                tagSources.push(object.definitionTags);
            }
        }

        const tags = new Set();
        for (const tagSource of tagSources) {
            for (const tag of tagSource) {
                tags.add(tag.name);
            }
        }

        return [...tags].join(', ');
    }

    /** @type {import('template-renderer').HelperFunction<string>} */
    _eachUpTo(args, context, options) {
        const [iterable, maxCount] = /** @type {[iterable: Iterable<unknown>, maxCount: number]} */ (args);
        if (iterable) {
            const results = [];
            let any = false;
            for (const entry of iterable) {
                any = true;
                if (results.length >= maxCount) { break; }
                const processedEntry = this._computeValue(options, entry);
                results.push(processedEntry);
            }
            if (any) {
                return results.join('');
            }
        }
        return this._computeInverseString(options, context);
    }

    /** @type {import('template-renderer').HelperFunction<unknown[]>} */
    _spread(args) {
        const result = [];
        for (const array of /** @type {Iterable<unknown>[]} */ (args)) {
            try {
                result.push(...array);
            } catch (e) {
                // NOP
            }
        }
        return result;
    }

    /** @type {import('template-renderer').HelperFunction<unknown>} */
    _op(args) {
        const [operator] = /** @type {[operator: string, operand1: import('core').SafeAny, operand2?: import('core').SafeAny, operand3?: import('core').SafeAny]} */ (args);
        switch (args.length) {
            case 2: return this._evaluateUnaryExpression(operator, args[1]);
            case 3: return this._evaluateBinaryExpression(operator, args[1], args[2]);
            case 4: return this._evaluateTernaryExpression(operator, args[1], args[2], args[3]);
            default: return void 0;
        }
    }

    /**
     * @param {string} operator
     * @param {import('core').SafeAny} operand1
     * @returns {unknown}
     */
    _evaluateUnaryExpression(operator, operand1) {
        switch (operator) {
            case '+': return +operand1;
            case '-': return -operand1;
            case '~': return ~operand1;
            case '!': return !operand1;
            default: return void 0;
        }
    }

    /**
     * @param {string} operator
     * @param {import('core').SafeAny} operand1
     * @param {import('core').SafeAny} operand2
     * @returns {unknown}
     */
    _evaluateBinaryExpression(operator, operand1, operand2) {
        switch (operator) {
            case '+': return operand1 + operand2;
            case '-': return operand1 - operand2;
            case '/': return operand1 / operand2;
            case '*': return operand1 * operand2;
            case '%': return operand1 % operand2;
            case '**': return operand1 ** operand2;
            case '==': return operand1 == operand2; // eslint-disable-line eqeqeq
            case '!=': return operand1 != operand2; // eslint-disable-line eqeqeq
            case '===': return operand1 === operand2;
            case '!==': return operand1 !== operand2;
            case '<': return operand1 < operand2;
            case '<=': return operand1 <= operand2;
            case '>': return operand1 > operand2;
            case '>=': return operand1 >= operand2;
            case '<<': return operand1 << operand2;
            case '>>': return operand1 >> operand2;
            case '>>>': return operand1 >>> operand2;
            case '&': return operand1 & operand2;
            case '|': return operand1 | operand2;
            case '^': return operand1 ^ operand2;
            case '&&': return operand1 && operand2;
            case '||': return operand1 || operand2;
            default: return void 0;
        }
    }

    /**
     * @param {string} operator
     * @param {import('core').SafeAny} operand1
     * @param {import('core').SafeAny} operand2
     * @param {import('core').SafeAny} operand3
     * @returns {unknown}
     */
    _evaluateTernaryExpression(operator, operand1, operand2, operand3) {
        switch (operator) {
            case '?:': return operand1 ? operand2 : operand3;
            default: return void 0;
        }
    }

    /** @type {import('template-renderer').HelperFunction<unknown>} */
    _get(args) {
        const [key] = /** @type {[key: string]} */ (args);
        const stateStack = this._stateStack;
        if (stateStack === null) { throw new Error('Invalid state'); }
        for (let i = stateStack.length; --i >= 0;) {
            const map = stateStack[i];
            if (map.has(key)) {
                return map.get(key);
            }
        }
        return void 0;
    }

    /** @type {import('template-renderer').HelperFunction<string>} */
    _set(args, context, options) {
        const stateStack = this._stateStack;
        if (stateStack === null) { throw new Error('Invalid state'); }
        switch (args.length) {
            case 1:
                {
                    const [key] = /** @type {[key: string]} */ (args);
                    const value = this._computeValue(options, context);
                    stateStack[stateStack.length - 1].set(key, value);
                }
                break;
            case 2:
                {
                    const [key, value] = /** @type {[key: string, value: unknown]} */ (args);
                    stateStack[stateStack.length - 1].set(key, value);
                }
                break;
        }
        return '';
    }

    /** @type {import('template-renderer').HelperFunction<unknown>} */
    _scope(_args, context, options) {
        const stateStack = this._stateStack;
        if (stateStack === null) { throw new Error('Invalid state'); }
        try {
            stateStack.push(new Map());
            return this._computeValue(options, context);
        } finally {
            if (stateStack.length > 1) {
                stateStack.pop();
            }
        }
    }

    /** @type {import('template-renderer').HelperFunction<unknown>} */
    _property(args) {
        const ii = args.length;
        if (ii <= 0) { return void 0; }

        try {
            let value = args[0];
            for (let i = 1; i < ii; ++i) {
                if (typeof value !== 'object' || value === null) { throw new Error('Invalid object'); }
                const key = args[i];
                switch (typeof key) {
                    case 'number':
                    case 'string':
                    case 'symbol':
                        break;
                    default:
                        throw new Error('Invalid key');
                }
                value = /** @type {import('core').UnknownObject} */ (value)[key];
            }
            return value;
        } catch (e) {
            return void 0;
        }
    }

    /** @type {import('template-renderer').HelperFunction<unknown>} */
    _noop(_args, context, options) {
        return this._computeValue(options, context);
    }

    /** @type {import('template-renderer').HelperFunction<boolean>} */
    _isMoraPitchHigh(args) {
        const [index, position] = /** @type {[index: number, position: number]} */ (args);
        return isMoraPitchHigh(index, position);
    }

    /** @type {import('template-renderer').HelperFunction<string[]>} */
    _getKanaMorae(args) {
        const [text] = /** @type {[text: string]} */ (args);
        return getKanaMorae(`${text}`);
    }

    /** @type {import('template-renderer').HelperFunction<import('core').TypeofResult>} */
    _getTypeof(args, context, options) {
        const ii = args.length;
        const value = (ii > 0 ? args[0] : this._computeValue(options, context));
        return typeof value;
    }

    /** @type {import('template-renderer').HelperFunction<string>} */
    _join(args) {
        return args.length > 0 ? args.slice(1, args.length).flat().join(/** @type {string} */ (args[0])) : '';
    }

    /** @type {import('template-renderer').HelperFunction<string>} */
    _concat(args) {
        let result = '';
        for (let i = 0, ii = args.length; i < ii; ++i) {
            // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
            result += args[i];
        }
        return result;
    }

    /** @type {import('template-renderer').HelperFunction<string[]>} */
    _pitchCategories(args) {
        const [data] = /** @type {[data: import('anki-templates').NoteData]} */ (args);
        const {dictionaryEntry} = data;
        if (dictionaryEntry.type !== 'term') { return []; }
        const {pronunciations: termPronunciations, headwords} = dictionaryEntry;
        /** @type {Set<string>} */
        const categories = new Set();
        for (const {headwordIndex, pronunciations} of termPronunciations) {
            const {reading, wordClasses} = headwords[headwordIndex];
            const isVerbOrAdjective = isNonNounVerbOrAdjective(wordClasses);
            const pitches = getPronunciationsOfType(pronunciations, 'pitch-accent');
            for (const {positions} of pitches) {
                const category = getPitchCategory(reading, positions, isVerbOrAdjective);
                if (category !== null) {
                    categories.add(category);
                }
            }
        }
        return [...categories];
    }

    /**
     * @returns {HTMLElement}
     */
    _getTemporaryElement() {
        let element = this._temporaryElement;
        if (element === null) {
            element = this._document.createElement('div');
            this._temporaryElement = element;
        }
        return element;
    }

    /**
     * @param {Element} node
     * @returns {string}
     */
    _getStructuredContentHtml(node) {
        return this._getHtml(node, this._structuredContentStyleApplier, this._structuredContentDatasetKeyIgnorePattern);
    }

    /**
     * @param {Element} node
     * @returns {string}
     */
    _getStructuredContentText(node) {
        return this._getText(node, this._structuredContentStyleApplier, this._structuredContentDatasetKeyIgnorePattern);
    }

    /**
     * @param {Element} node
     * @returns {string}
     */
    _getPronunciationHtml(node) {
        return this._getHtml(node, this._pronunciationStyleApplier, null);
    }

    /**
     * @param {Element} node
     * @param {CssStyleApplier} styleApplier
     * @param {?RegExp} datasetKeyIgnorePattern
     * @returns {string}
     */
    _getHtml(node, styleApplier, datasetKeyIgnorePattern) {
        const container = this._getTemporaryElement();
        container.appendChild(node);
        this._normalizeHtml(container, styleApplier, datasetKeyIgnorePattern);
        const result = container.innerHTML;
        container.textContent = '';
        return this._safeString(result);
    }

    /**
     * @param {Element} node
     * @param {CssStyleApplier} styleApplier
     * @param {?RegExp} datasetKeyIgnorePattern
     * @returns {string}
     */
    _getText(node, styleApplier, datasetKeyIgnorePattern) {
        const container = this._getTemporaryElement();
        container.appendChild(node);
        this._normalizeHtml(container, styleApplier, datasetKeyIgnorePattern);
        const result = container.innerHTML
            .replaceAll(/<(div|li|ol|ul|br|details|summary|hr)(\s.*?>|>)/g, '\n') // tags that usually cause line breaks
            .replaceAll(/<(span|a|ruby)(\s.*?>|>)/g, ' ') // tags that usually signify some change in content
            .replaceAll(/<rt(\s.*?>|>)/g, '[') // ruby start
            .replaceAll('</rt>', ']') // ruby end
            .replaceAll(/<.*?>/gs, '') // remove all remaining tags
            .replaceAll('<', '&lt;') // escape remaining <
            .replaceAll('>', '&rt;') // and >
            .replaceAll(/\n+/g, '<br>') // convert newlines into linebreaks and condense newlines
            .replaceAll(/^(\s*<br>\s*|\s)*/g, '') // remove leading linebreaks and whitespace
            .replaceAll('<br>', '<br>\n');
        container.textContent = '';
        return this._safeString(result);
    }

    /**
     * @param {Element} root
     * @param {CssStyleApplier} styleApplier
     * @param {?RegExp} datasetKeyIgnorePattern
     */
    _normalizeHtml(root, styleApplier, datasetKeyIgnorePattern) {
        const TEXT_NODE = this._document.TEXT_NODE;
        const ELEMENT_NODE = this._document.ELEMENT_NODE;
        const treeWalker = this._document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        /** @type {HTMLElement[]} */
        const elements = [];
        /** @type {Text[]} */
        const textNodes = [];
        while (true) {
            const node = treeWalker.nextNode();
            if (node === null) { break; }
            switch (node.nodeType) {
                case ELEMENT_NODE:
                    elements.push(/** @type {HTMLElement} */ (node));
                    break;
                case TEXT_NODE:
                    textNodes.push(/** @type {Text} */ (node));
                    break;
            }
        }
        styleApplier.applyClassStyles(elements);
        for (const element of elements) {
            const {dataset} = element;
            for (const key of Object.keys(dataset)) {
                if (datasetKeyIgnorePattern !== null && datasetKeyIgnorePattern.test(key)) { continue; }
                delete dataset[key];
            }
        }
        for (const textNode of textNodes) {
            this._replaceNewlines(textNode);
        }
    }

    /**
     * @param {Text} textNode
     */
    _replaceNewlines(textNode) {
        const parts = /** @type {string} */ (textNode.nodeValue).split('\n');
        if (parts.length <= 1) { return; }
        const {parentNode} = textNode;
        if (parentNode === null) { return; }
        const fragment = this._document.createDocumentFragment();
        for (let i = 0, ii = parts.length; i < ii; ++i) {
            if (i > 0) { fragment.appendChild(this._document.createElement('br')); }
            fragment.appendChild(this._document.createTextNode(parts[i]));
        }
        parentNode.replaceChild(fragment, textNode);
    }

    /**
     * @param {import('anki-templates').NoteData} data
     * @returns {StructuredContentGenerator}
     */
    _createStructuredContentGenerator(data) {
        const contentManager = new AnkiTemplateRendererContentManager(this._mediaProvider, data);
        const instance = new StructuredContentGenerator(contentManager, this._document, this._window);
        this._cleanupCallbacks.push(() => contentManager.unloadAll());
        return instance;
    }

    /**
     * @param {import('template-renderer').HelperOptions} options
     * @returns {import('anki-templates').NoteData}
     */
    _getNoteDataFromOptions(options) {
        return options.data.root;
    }

    /**
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _formatGlossary(args, _context, options) {
        const [dictionary, content] = /** @type {[dictionary: string, content: import('dictionary-data').TermGlossaryContent]} */ (args);
        const data = this._getNoteDataFromOptions(options);
        if (typeof content === 'string') { return this._safeString(this._stringToMultiLineHtml(content)); }
        if (!(typeof content === 'object' && content !== null)) { return ''; }
        switch (content.type) {
            case 'image': return this._formatGlossaryImage(content, dictionary, data);
            case 'structured-content': return this._formatStructuredContent(content, dictionary, data);
            case 'text': return this._safeString(this._stringToMultiLineHtml(content.text));
        }
        return '';
    }

    /**
     * @param {import('dictionary-data').TermGlossaryImage} content
     * @param {string} dictionary
     * @param {import('anki-templates').NoteData} data
     * @returns {string}
     */
    _formatGlossaryImage(content, dictionary, data) {
        const structuredContentGenerator = this._createStructuredContentGenerator(data);
        const node = structuredContentGenerator.createDefinitionImage(content, dictionary);
        return this._getStructuredContentHtml(node);
    }

    /**
     * @param {import('dictionary-data').TermGlossaryStructuredContent} content
     * @param {string} dictionary
     * @param {import('anki-templates').NoteData} data
     * @returns {string}
     */
    _formatStructuredContent(content, dictionary, data) {
        const structuredContentGenerator = this._createStructuredContentGenerator(data);
        const node = structuredContentGenerator.createStructuredContent(content.content, dictionary);
        return node !== null ? this._getStructuredContentHtml(node) : '';
    }

    /**
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _formatGlossaryPlain(args, _context, options) {
        const [dictionary, content] = /** @type {[dictionary: string, content: import('dictionary-data').TermGlossaryContent]} */ (args);
        const data = this._getNoteDataFromOptions(options);
        if (typeof content === 'string') { return this._safeString(content); }
        if (!(typeof content === 'object' && content !== null)) { return ''; }
        const structuredContentGenerator = this._createStructuredContentGenerator(data);
        switch (content.type) {
            case 'image': return '';
            case 'structured-content': {
                const glossaryStrings = this._extractGlossaryData(content, structuredContentGenerator);
                if (glossaryStrings.length > 0) {
                    return glossaryStrings.join('<br>\n');
                } else {
                    const node = structuredContentGenerator.createStructuredContent(content.content, dictionary);
                    return node !== null ? this._getStructuredContentText(node) : '';
                }
            }
            case 'text': return this._safeString(content.text);
        }
        return '';
    }

    /**
     * @param {import('dictionary-data').TermGlossaryStructuredContent} content
     * @param {StructuredContentGenerator} structuredContentGenerator
     * @returns {string[]}
     */
    _extractGlossaryData(content, structuredContentGenerator) {
        /** @type {import('structured-content.js').Content[]} */
        const glossaryContentQueue = [];
        const structuredContentQueue = [content.content];
        while (structuredContentQueue.length > 0) {
            const structuredContent = structuredContentQueue.pop();
            if (Array.isArray(structuredContent)) {
                structuredContentQueue.push(...structuredContent);
            } else if (typeof structuredContent === 'object' && structuredContent.content) {
                // @ts-expect-error - Checking if `data` exists
                if (structuredContent.data?.content === 'glossary') {
                    glossaryContentQueue.push(structuredContent);
                    continue;
                }
                structuredContentQueue.push(structuredContent.content);
            }
        }

        /** @type {string[]} */
        const rawGlossaryContent = [];
        while (glossaryContentQueue.length > 0) {
            const structuredGloss = glossaryContentQueue.shift();
            if (typeof structuredGloss === 'string') {
                rawGlossaryContent.push(structuredGloss);
            } else if (Array.isArray(structuredGloss)) {
                glossaryContentQueue.push(...structuredGloss);
            } else if (typeof structuredGloss === 'object' && structuredGloss.content) {
                if (structuredGloss.tag === 'ruby') {
                    const node = structuredContentGenerator.createStructuredContent(structuredGloss.content, '');
                    rawGlossaryContent.push(node !== null ? this._getStructuredContentText(node) : '');
                    continue;
                }
                glossaryContentQueue.push(structuredGloss.content);
            }
        }
        return rawGlossaryContent;
    }

    /**
     * @type {import('template-renderer').HelperFunction<boolean>}
     */
    _hasMedia(args, _context, options) {
        const data = this._getNoteDataFromOptions(options);
        return this._mediaProvider.hasMedia(data, args, options.hash);
    }

    /**
     * @type {import('template-renderer').HelperFunction<?string>}
     */
    _getMedia(args, _context, options) {
        const data = this._getNoteDataFromOptions(options);
        return this._mediaProvider.getMedia(data, args, options.hash);
    }

    /**
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _pronunciation(_args, _context, options) {
        const {format, reading, pitchPositions} = options.hash;

        if (
            typeof reading !== 'string' ||
            reading.length === 0 ||
            (typeof pitchPositions !== 'number' && typeof pitchPositions !== 'string')
        ) {
            return '';
        }
        const morae = getKanaMorae(reading);

        switch (format) {
            case 'text':
            {
                const nasalPositions = this._getValidNumberArray(options.hash.nasalPositions);
                const devoicePositions = this._getValidNumberArray(options.hash.devoicePositions);
                return this._getPronunciationHtml(this._pronunciationGenerator.createPronunciationText(morae, pitchPositions, nasalPositions, devoicePositions));
            }
            case 'graph':
                return this._getPronunciationHtml(this._pronunciationGenerator.createPronunciationGraph(morae, pitchPositions));
            case 'graph-jj':
                return this._getPronunciationHtml(this._pronunciationGenerator.createPronunciationGraphJJ(morae, pitchPositions));
            case 'position':
                return this._getPronunciationHtml(this._pronunciationGenerator.createPronunciationDownstepPosition(pitchPositions));
            default:
                return '';
        }
    }

    /**
     * @param {unknown} value
     * @returns {number[]}
     */
    _getValidNumberArray(value) {
        const result = [];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'number') { result.push(item); }
            }
        }
        return result;
    }

    /**
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _hiragana(args, context, options) {
        const ii = args.length;
        const {keepProlongedSoundMarks} = options.hash;
        const value = (ii > 0 ? args[0] : this._computeValue(options, context));
        return typeof value === 'string' ? convertKatakanaToHiragana(value, keepProlongedSoundMarks === true) : '';
    }

    /**
     * @type {import('template-renderer').HelperFunction<string>}
     */
    _katakana(args, context, options) {
        const ii = args.length;
        const value = (ii > 0 ? args[0] : this._computeValue(options, context));
        return typeof value === 'string' ? convertHiraganaToKatakana(value) : '';
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    _asString(value) {
        return typeof value === 'string' ? value : `${value}`;
    }

    /**
     * @param {import('template-renderer').HelperOptions} options
     * @param {unknown} context
     * @returns {unknown}
     */
    _computeValue(options, context) {
        return typeof options.fn === 'function' ? options.fn(context) : '';
    }

    /**
     * @param {import('template-renderer').HelperOptions} options
     * @param {unknown} context
     * @returns {string}
     */
    _computeValueString(options, context) {
        return this._asString(this._computeValue(options, context));
    }

    /**
     * @param {import('template-renderer').HelperOptions} options
     * @param {unknown} context
     * @returns {unknown}
     */
    _computeInverse(options, context) {
        return typeof options.inverse === 'function' ? options.inverse(context) : '';
    }

    /**
     * @param {import('template-renderer').HelperOptions} options
     * @param {unknown} context
     * @returns {string}
     */
    _computeInverseString(options, context) {
        return this._asString(this._computeInverse(options, context));
    }
}
