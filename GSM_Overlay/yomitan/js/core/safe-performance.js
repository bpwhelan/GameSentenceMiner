/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {log} from './log.js';

/**
 * This class safely handles performance methods.
 */
class SafePerformance {
    constructor() {
        /** @type {Map<string, number>} */
        this._markCounts = new Map();
        /** @type {Map<string, number>} */
        this._measureCounts = new Map();
    }

    /**
     * @param {string} markName
     * @param {PerformanceMarkOptions} [markOptions]
     * @returns {PerformanceMark | undefined}
     */
    mark(markName, markOptions) {
        try {
            if (this._rollOver(this._markCounts, markName)) {
                // eslint-disable-next-line no-restricted-syntax
                performance.clearMarks(markName);
            }
            // eslint-disable-next-line no-restricted-syntax
            return performance.mark(markName, markOptions);
        } catch (e) {
            log.error(e);
        }
    }

    /**
     *
     * @param {string} measureName
     * @param {string | PerformanceMeasureOptions} [startOrMeasureOptions]
     * @param {string} [endMark]
     * @returns {PerformanceMeasure | undefined}
     */
    measure(measureName, startOrMeasureOptions, endMark) {
        try {
            if (this._rollOver(this._measureCounts, measureName)) {
                // eslint-disable-next-line no-restricted-syntax
                performance.clearMeasures(measureName);
            }
            // eslint-disable-next-line no-restricted-syntax
            return performance.measure(measureName, startOrMeasureOptions, endMark);
        } catch (e) {
            log.error(e);
        }
    }

    /**
     * @returns {DOMHighResTimeStamp}
     */
    now() {
        // eslint-disable-next-line no-restricted-syntax
        return performance.now();
    }

    /**
     * Bound the timeline in long-lived scanners and dictionary workers. Clear
     * each name only when replacing it so an in-flight measurement can still
     * find its start mark. Recent entries remain available for diagnostics.
     * @param {Map<string, number>} counts
     * @param {string} name
     * @returns {boolean}
     */
    _rollOver(counts, name) {
        const count = counts.get(name) ?? 0;
        counts.set(name, count === 64 ? 1 : count + 1);
        return count === 64;
    }
}

/**
 * This object is the default performance measurer used by the runtime.
 */
export const safePerformance = new SafePerformance();
