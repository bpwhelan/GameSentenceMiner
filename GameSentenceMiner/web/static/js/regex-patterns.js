// Shared regex patterns for search and deletion functionality
// This module provides preset regex patterns and helper functions

/**
 * Preset regex patterns with descriptions
 * Each pattern includes:
 * - value: unique identifier
 * - label: user-friendly description
 * - pattern: the actual regex pattern
 */
export const PRESET_PATTERNS = {
    'lines_over_50': {
        label: 'Lines over 50 characters',
        pattern: '.{51,}'
    },
    'lines_over_100': {
        label: 'Lines over 100 characters',
        pattern: '.{101,}'
    },
    'non_japanese': {
        label: 'Non-Japanese text',
        pattern: '^[^\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]*$'
    },
    'ascii_only': {
        label: 'ASCII-only lines',
        pattern: '^[\x00-\x7F]*$'
    },
    'empty_lines': {
        label: 'Empty or whitespace-only lines',
        pattern: '^\s*$'
    },
    'numbers_only': {
        label: 'Lines with numbers only',
        pattern: '^\d+$'
    },
    'single_char': {
        label: 'Single character lines',
        pattern: '^.{1}$'
    },
    'repeated_chars': {
        label: 'Lines with repeated characters (3+ times)',
        pattern: '(.)\\1{2,}'
    },
    'everything': {
        label: 'Everything',
        pattern: '.*'
    }
};

/**
 * Get pattern by key
 * @param {string} key - Pattern key
 * @returns {string|null} - Pattern string or null if not found
 */
export function getPattern(key) {
    return PRESET_PATTERNS[key]?.pattern || null;
}

/**
 * Get all pattern options for dropdown
 * @returns {Array} - Array of {value, label} objects
 */
export function getPatternOptions() {
    return Object.entries(PRESET_PATTERNS).map(([key, data]) => ({
        value: key,
        label: data.label
    }));
}

/**
 * Validate regex pattern
 * @param {string} pattern - Regex pattern to validate
 * @returns {Object} - {valid: boolean, error: string|null}
 */
export function validateRegex(pattern) {
    try {
        new RegExp(pattern);
        return { valid: true, error: null };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

/**
 * Apply regex pattern to text
 * @param {string} text - Text to test
 * @param {string} pattern - Regex pattern
 * @param {boolean} caseSensitive - Case sensitivity flag
 * @returns {boolean} - True if pattern matches
 */
export function testPattern(text, pattern, caseSensitive = false) {
    try {
        const flags = caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(pattern, flags);
        return regex.test(text);
    } catch (e) {
        console.error('Regex test error:', e);
        return false;
    }
}