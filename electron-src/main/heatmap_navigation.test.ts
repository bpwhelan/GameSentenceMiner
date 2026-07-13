import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

describe('heatmap date navigation', () => {
    it('renders valid dates as links when a date URL builder is configured', () => {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        const scriptPath = path.resolve(
            currentDir,
            '../../GameSentenceMiner/web/static/js/heatmap.js'
        );
        const source = fs.readFileSync(scriptPath, 'utf8');
        const dom = new JSDOM('<div id="heatmapContainer"></div>');
        const context = vm.createContext({
            console,
            document: dom.window.document,
            window: dom.window,
        });

        vm.runInContext(source, context, { filename: scriptPath });
        const HeatmapRenderer = dom.window.HeatmapRenderer as unknown as new (
            options: Record<string, unknown>
        ) => { render: (data: Record<string, Record<string, number>>) => void };
        const renderer = new HeatmapRenderer({
            containerId: 'heatmapContainer',
            calculateStreaks: () => ({ longestStreak: 0, currentStreak: 0, avgDaily: 0 }),
            getDateUrl: (date: string) => `/search?from_date=${date}&to_date=${date}`,
        });

        renderer.render({ 2024: { '2024-06-01': 42 } });

        const dayLink = dom.window.document.querySelector<HTMLAnchorElement>(
            '.heatmap-cell[data-date="2024-06-01"]'
        );
        expect(dayLink?.tagName).toBe('A');
        expect(dayLink?.getAttribute('href')).toBe(
            '/search?from_date=2024-06-01&to_date=2024-06-01'
        );
    });
});
