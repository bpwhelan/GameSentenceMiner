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

import {readCodePointsBackward, readCodePointsForward} from '../data/string-util.js';

/**
 * A class used to scan text in a document.
 */
export class DOMTextScanner {
    /**
     * A regular expression used to match word delimiters.
     * \p{L} matches any kind of letter from any language
     * \p{N} matches any kind of numeric character in any script
     * @type {RegExp}
     */
    static WORD_DELIMITER_REGEX = /[^\w\p{L}\p{N}]/u;

    /**
     * Creates a new instance of a DOMTextScanner.
     * @param {Node} node The DOM Node to start at.
     * @param {number} offset The character offset in to start at when node is a text node.
     *   Use 0 for non-text nodes.
     * @param {boolean} forcePreserveWhitespace Whether or not whitespace should be forced to be preserved,
     *   regardless of CSS styling.
     * @param {boolean} generateLayoutContent Whether or not newlines should be added based on CSS styling.
     * @param {boolean} stopAtWordBoundary Whether to pause scanning when whitespace is encountered when scanning backwards.
     */
    constructor(node, offset, forcePreserveWhitespace = false, generateLayoutContent = true, stopAtWordBoundary = false) {
        const ruby = DOMTextScanner.getParentRubyElement(node);
        const resetOffset = (ruby !== null);
        if (resetOffset) { node = ruby; }

        /** @type {Node} */
        this._initialNode = node;
        /** @type {Node} */
        this._node = node;
        /** @type {number} */
        this._offset = offset;
        /** @type {string} */
        this._content = '';
        /** @type {number} */
        this._remainder = 0;
        /** @type {boolean} */
        this._resetOffset = resetOffset;
        /** @type {number} */
        this._newlines = 0;
        /** @type {boolean} */
        this._lineHasWhitespace = false;
        /** @type {boolean} */
        this._lineHasContent = false;
        /**
         * @type {boolean} Whether or not whitespace should be forced to be preserved,
         * regardless of CSS styling.
         */
        this._forcePreserveWhitespace = forcePreserveWhitespace;
        /** @type {boolean} */
        this._generateLayoutContent = generateLayoutContent;
        /**
         * @type {boolean} Whether or not to stop scanning when word boundaries are encountered.
         */
        this._stopAtWordBoundary = stopAtWordBoundary;
    }

    /**
     * Gets the current node being scanned.
     * @type {Node}
     */
    get node() {
        return this._node;
    }

    /**
     * Gets the current offset corresponding to the node being scanned.
     * This value is only applicable for text nodes.
     * @type {number}
     */
    get offset() {
        return this._offset;
    }

    /**
     * Gets the remaining number of characters that weren't scanned in the last seek() call.
     * This value is usually 0 unless the end of the document was reached.
     * @type {number}
     */
    get remainder() {
        return this._remainder;
    }

    /**
     * Gets the accumulated content string resulting from calls to seek().
     * @type {string}
     */
    get content() {
        return this._content;
    }

    /**
     * Seeks a given length in the document and accumulates the text content.
     * @param {number} length A positive or negative integer corresponding to how many characters
     *   should be added to content. Content is only added to the accumulation string,
     *   never removed, so mixing seek calls with differently signed length values
     *   may give unexpected results.
     * @returns {DOMTextScanner} this
     */
    seek(length) {
        const forward = (length >= 0);
        this._remainder = (forward ? length : -length);
        if (length === 0) { return this; }

        const TEXT_NODE = Node.TEXT_NODE;
        const ELEMENT_NODE = Node.ELEMENT_NODE;

        const generateLayoutContent = this._generateLayoutContent;
        let node = /** @type {?Node} */ (this._node);
        let lastNode = /** @type {Node} */ (node);
        let resetOffset = this._resetOffset;
        let newlines = 0;
        seekLoop:
        while (node !== null) {
            let enterable = false;
            const nodeType = node.nodeType;

            if (nodeType === TEXT_NODE) {
                lastNode = node;
                const shouldContinueScanning = forward ?
                    this._seekTextNodeForward(/** @type {Text} */ (node), resetOffset) :
                    this._seekTextNodeBackward(/** @type {Text} */ (node), resetOffset);

                if (!shouldContinueScanning) {
                    // Length reached or reached a word boundary
                    break;
                }
            } else if (nodeType === ELEMENT_NODE) {
                if (this._stopAtWordBoundary && !forward) {
                    // Element nodes are considered word boundaries when scanning backwards
                    break;
                }
                lastNode = node;
                const initialNodeAtBeginningOfNodeGoingBackwards = node === this._initialNode && this._offset === 0 && !forward;
                const initialNodeAtEndOfNodeGoingForwards = node === this._initialNode && this._offset === node.childNodes.length && forward;
                this._offset = 0;
                const isInitialNode = node === this._initialNode;
                ({enterable, newlines} = DOMTextScanner.getElementSeekInfo(/** @type {Element} */ (node)));
                if (!isInitialNode && newlines > this._newlines && generateLayoutContent) {
                    this._newlines = newlines;
                }
                if (initialNodeAtBeginningOfNodeGoingBackwards || initialNodeAtEndOfNodeGoingForwards) {
                    enterable = false;
                }
            }

            /** @type {Node[]} */
            const exitedNodes = [];
            node = DOMTextScanner.getNextNodeToProcess(node, forward, enterable, exitedNodes);

            for (const exitedNode of exitedNodes) {
                if (exitedNode.nodeType !== ELEMENT_NODE) { continue; }
                ({newlines} = DOMTextScanner.getElementSeekInfo(/** @type {Element} */ (exitedNode)));
                if (newlines > this._newlines && generateLayoutContent) {
                    this._newlines = newlines;
                }
                if (newlines > 0 && this._stopAtWordBoundary && !forward) {
                    // Element nodes are considered word boundaries when scanning backwards
                    break seekLoop;
                }
            }

            resetOffset = true;
        }

        this._node = lastNode;
        this._resetOffset = resetOffset;

        return this;
    }

    // Private

    /**
     * Seeks forward in a text node.
     * @param {Text} textNode The text node to use.
     * @param {boolean} resetOffset Whether or not the text offset should be reset.
     * @returns {boolean} `true` if scanning should continue, or `false` if the scan length has been reached.
     */
    _seekTextNodeForward(textNode, resetOffset) {
        const nodeValue = /** @type {string} */ (textNode.nodeValue);
        const nodeValueLength = nodeValue.length;
        const {preserveNewlines, preserveWhitespace} = this._getWhitespaceSettings(textNode);
        if (resetOffset) { this._offset = 0; }

        while (this._offset < nodeValueLength) {
            const char = readCodePointsForward(nodeValue, this._offset, 1);
            this._offset += char.length;
            const charAttributes = DOMTextScanner.getCharacterAttributes(char, preserveNewlines, preserveWhitespace);
            if (this._checkCharacterForward(char, charAttributes)) { break; }
        }

        return this._remainder > 0;
    }

    /**
     * Seeks backward in a text node.
     * This function is nearly the same as _seekTextNodeForward, with the following differences:
     * - Iteration condition is reversed to check if offset is greater than 0.
     * - offset is reset to nodeValueLength instead of 0.
     * - offset is decremented instead of incremented.
     * - offset is decremented before getting the character.
     * - offset is reverted by incrementing instead of decrementing.
     * - content string is prepended instead of appended.
     * @param {Text} textNode The text node to use.
     * @param {boolean} resetOffset Whether or not the text offset should be reset.
     * @returns {boolean} `true` if scanning should continue, or `false` if the scan length has been reached.
     */
    _seekTextNodeBackward(textNode, resetOffset) {
        const nodeValue = /** @type {string} */ (textNode.nodeValue);
        const nodeValueLength = nodeValue.length;
        const {preserveNewlines, preserveWhitespace} = this._getWhitespaceSettings(textNode);
        if (resetOffset) { this._offset = nodeValueLength; }
        while (this._offset > 0) {
            const char = readCodePointsBackward(nodeValue, this._offset - 1, 1);
            if (this._stopAtWordBoundary && DOMTextScanner.isWordDelimiter(char)) {
                if (DOMTextScanner.isSingleQuote(char) && this._offset > 1) {
                    // Check to see if char before single quote is a word character (e.g. "don't")
                    const prevChar = readCodePointsBackward(nodeValue, this._offset - 2, 1);
                    if (DOMTextScanner.isWordDelimiter(prevChar)) {
                        return false;
                    }
                } else {
                    return false;
                }
            }
            this._offset -= char.length;
            const charAttributes = DOMTextScanner.getCharacterAttributes(char, preserveNewlines, preserveWhitespace);
            if (this._checkCharacterBackward(char, charAttributes)) { break; }
        }

        return this._remainder > 0;
    }

    /**
     * Gets information about how whitespace characters are treated.
     * @param {Text} textNode
     * @returns {import('dom-text-scanner').WhitespaceSettings}
     */
    _getWhitespaceSettings(textNode) {
        if (this._forcePreserveWhitespace) {
            return {preserveNewlines: true, preserveWhitespace: true};
        }
        const element = DOMTextScanner.getParentElement(textNode);
        if (element !== null) {
            const style = window.getComputedStyle(element);
            switch (style.whiteSpace) {
                case 'pre':
                case 'pre-wrap':
                case 'break-spaces':
                    return {preserveNewlines: true, preserveWhitespace: true};
                case 'pre-line':
                    return {preserveNewlines: true, preserveWhitespace: false};
            }
        }
        return {preserveNewlines: false, preserveWhitespace: false};
    }

    /**
     * @param {string} char
     * @param {import('dom-text-scanner').CharacterAttributes} charAttributes
     * @returns {boolean} Whether or not to stop scanning.
     */
    _checkCharacterForward(char, charAttributes) {
        switch (charAttributes) {
            // case 0: break; // NOP
            case 1:
                this._lineHasWhitespace = true;
                break;
            case 2:
            case 3:
                if (this._newlines > 0) {
                    const useNewlineCount = Math.min(this._remainder, this._newlines);
                    this._content += '\n'.repeat(useNewlineCount);
                    this._remainder -= useNewlineCount;
                    this._newlines -= useNewlineCount;
                    this._lineHasContent = false;
                    this._lineHasWhitespace = false;
                    if (this._remainder <= 0) {
                        this._offset -= char.length; // Revert character offset
                        return true;
                    }
                }

                this._lineHasContent = (charAttributes === 2); // 3 = character is a newline

                if (this._lineHasWhitespace) {
                    if (this._lineHasContent) {
                        this._content += ' ';
                        this._lineHasWhitespace = false;
                        if (--this._remainder <= 0) {
                            this._offset -= char.length; // Revert character offset
                            return true;
                        }
                    } else {
                        this._lineHasWhitespace = false;
                    }
                }

                this._content += char;

                if (--this._remainder <= 0) {
                    return true;
                }
                break;
        }

        return false;
    }

    /**
     * @param {string} char
     * @param {import('dom-text-scanner').CharacterAttributes} charAttributes
     * @returns {boolean} Whether or not to stop scanning.
     */
    _checkCharacterBackward(char, charAttributes) {
        switch (charAttributes) {
            // case 0: break; // NOP
            case 1:
                this._lineHasWhitespace = true;
                break;
            case 2:
            case 3:
                if (this._newlines > 0) {
                    const useNewlineCount = Math.min(this._remainder, this._newlines);
                    this._content = '\n'.repeat(useNewlineCount) + this._content;
                    this._remainder -= useNewlineCount;
                    this._newlines -= useNewlineCount;
                    this._lineHasContent = false;
                    this._lineHasWhitespace = false;
                    if (this._remainder <= 0) {
                        this._offset += char.length; // Revert character offset
                        return true;
                    }
                }

                this._lineHasContent = (charAttributes === 2); // 3 = character is a newline

                if (this._lineHasWhitespace) {
                    if (this._lineHasContent) {
                        this._content = ' ' + this._content;
                        this._lineHasWhitespace = false;
                        if (--this._remainder <= 0) {
                            this._offset += char.length; // Revert character offset
                            return true;
                        }
                    } else {
                        this._lineHasWhitespace = false;
                    }
                }

                this._content = char + this._content;

                if (--this._remainder <= 0) {
                    return true;
                }
                break;
        }

        return false;
    }

    // Static helpers

    /**
     * Gets the next node to process in the document for a specified scanning direction.
     * @param {Node} node The current DOM Node.
     * @param {boolean} forward Whether to scan forward in the document or backward.
     * @param {boolean} visitChildren Whether the children of the current node should be visited.
     * @param {Node[]} exitedNodes An array which stores nodes which were exited.
     * @returns {?Node} The next node in the document, or `null` if there is no next node.
     */
    static getNextNodeToProcess(node, forward, visitChildren, exitedNodes) {
        /** @type {?Node} */
        let next = visitChildren ? (forward ? node.firstChild : node.lastChild) : null;
        if (next === null) {
            while (true) {
                exitedNodes.push(node);

                next = (forward ? node.nextSibling : node.previousSibling);
                if (next !== null) { break; }

                next = node.parentNode;
                if (next === null) { break; }

                node = next;
            }
        }
        return next;
    }

    /**
     * Gets the parent element of a given Node.
     * @param {?Node} node The node to check.
     * @returns {?Element} The parent element if one exists, otherwise `null`.
     */
    static getParentElement(node) {
        while (node !== null) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                return /** @type {Element} */ (node);
            }
            node = node.parentNode;
        }
        return null;
    }

    /**
     * Gets the parent <ruby> element of a given node, if one exists. For efficiency purposes,
     * this only checks the immediate parent elements and does not check all ancestors, so
     * there are cases where the node may be in a ruby element but it is not returned.
     * @param {Node} node The node to check.
     * @returns {?HTMLElement} A <ruby> node if the input node is contained in one, otherwise `null`.
     */
    static getParentRubyElement(node) {
        /** @type {?Node} */
        let node2 = DOMTextScanner.getParentElement(node);
        if (node2 !== null && node2.nodeName.toUpperCase() === 'RT') {
            node2 = node2.parentNode;
            if (node2 !== null && node2.nodeName.toUpperCase() === 'RUBY') {
                return /** @type {HTMLElement} */ (node2);
            }
        }
        return null;
    }

    /**
     * @param {Element} element
     * @returns {import('dom-text-scanner').ElementSeekInfo}
     */
    static getElementSeekInfo(element) {
        let enterable = true;
        switch (element.nodeName.toUpperCase()) {
            case 'HEAD':
            case 'RT':
            case 'SCRIPT':
            case 'STYLE':
                return {enterable: false, newlines: 0};
            case 'RB':
                return {enterable: true, newlines: 0};
            case 'BR':
                return {enterable: false, newlines: 1};
            case 'TEXTAREA':
            case 'INPUT':
            case 'BUTTON':
                enterable = false;
                break;
        }

        const style = window.getComputedStyle(element);
        const display = style.display;

        const visible = (display !== 'none' && DOMTextScanner.isStyleVisible(style));
        let newlines = 0;

        if (!visible) {
            enterable = false;
        } else {
            switch (style.position) {
                case 'absolute':
                case 'fixed':
                case 'sticky':
                    newlines = 2;
                    break;
            }
            if (newlines === 0 && DOMTextScanner.doesCSSDisplayChangeLayout(display)) {
                newlines = 1;
            }
        }

        return {enterable, newlines};
    }

    /**
     * Gets attributes for the specified character.
     * @param {string} character A string containing a single character.
     * @param {boolean} preserveNewlines Whether or not newlines should be preserved.
     * @param {boolean} preserveWhitespace Whether or not whitespace should be preserved.
     * @returns {import('dom-text-scanner').CharacterAttributes} An enum representing the attributes of the character.
     */
    static getCharacterAttributes(character, preserveNewlines, preserveWhitespace) {
        switch (character.charCodeAt(0)) {
            case 0x09: // Tab ('\t')
            case 0x0c: // Form feed ('\f')
            case 0x0d: // Carriage return ('\r')
            case 0x20: // Space (' ')
                return preserveWhitespace ? 2 : 1;
            case 0x0a: // Line feed ('\n')
                return preserveNewlines ? 3 : 1;
            case 0x200b: // Zero-width space
            case 0x200c: // Zero-width non-joiner
            case 0x00ad: // Soft hyphen
                return 0;
            default: // Other
                return 2;
        }
    }

    /**
     * @param {string} character
     * @returns {boolean}
     */
    static isWordDelimiter(character) {
        return DOMTextScanner.WORD_DELIMITER_REGEX.test(character);
    }

    /**
     * @param {string} character
     * @returns {boolean}
     */
    static isSingleQuote(character) {
        switch (character.charCodeAt(0)) {
            case 0x27: // Single quote ('')
            case 0x2019: // Right single quote (’)
            case 0x2032: // Prime (′)
            case 0x2035: // Reversed prime (‵)
            case 0x02bc: // Modifier letter apostrophe (ʼ)
                return true;
            default:
                return false;
        }
    }

    /**
     * Checks whether a given style is visible or not.
     * This function does not check `style.display === 'none'`.
     * @param {CSSStyleDeclaration} style An object implementing the CSSStyleDeclaration interface.
     * @returns {boolean} `true` if the style should result in an element being visible, otherwise `false`.
     */
    static isStyleVisible(style) {
        return !(
            style.visibility === 'hidden' ||
            Number.parseFloat(style.opacity) <= 0 ||
            Number.parseFloat(style.fontSize) <= 0 ||
            (
                !DOMTextScanner.isStyleSelectable(style) &&
                (
                    DOMTextScanner.isCSSColorTransparent(style.color) ||
                    DOMTextScanner.isCSSColorTransparent(style.webkitTextFillColor)
                )
            )
        );
    }

    /**
     * Checks whether a given style is selectable or not.
     * @param {CSSStyleDeclaration} style An object implementing the CSSStyleDeclaration interface.
     * @returns {boolean} `true` if the style is selectable, otherwise `false`.
     */
    static isStyleSelectable(style) {
        return !(
            style.userSelect === 'none' ||
            style.webkitUserSelect === 'none' ||
            // @ts-expect-error - vendor prefix
            style.MozUserSelect === 'none' ||
            // @ts-expect-error - vendor prefix
            style.msUserSelect === 'none'
        );
    }

    /**
     * Checks whether a CSS color is transparent or not.
     * @param {string} cssColor A CSS color string, expected to be encoded in rgb(a) form.
     * @returns {boolean} `true` if the color is transparent, otherwise `false`.
     */
    static isCSSColorTransparent(cssColor) {
        return (
            typeof cssColor === 'string' &&
            cssColor.startsWith('rgba(') &&
            /,\s*0.?0*\)$/.test(cssColor)
        );
    }

    /**
     * Checks whether a CSS display value will cause a layout change for text.
     * @param {string} cssDisplay A CSS string corresponding to the value of the display property.
     * @returns {boolean} `true` if the layout is changed by this value, otherwise `false`.
     */
    static doesCSSDisplayChangeLayout(cssDisplay) {
        let pos = cssDisplay.indexOf(' ');
        if (pos >= 0) {
            // Truncate to <display-outside> part
            cssDisplay = cssDisplay.substring(0, pos);
        }

        pos = cssDisplay.indexOf('-');
        if (pos >= 0) {
            // Truncate to first part of kebab-case value
            cssDisplay = cssDisplay.substring(0, pos);
        }

        switch (cssDisplay) {
            case 'block':
            case 'flex':
            case 'grid':
            case 'list': // Also includes: list-item
            case 'table': // Also includes: table, table-*
                return true;
            case 'ruby': // Also includes: ruby-*
                return (pos >= 0);
            default:
                return false;
        }
    }
}
