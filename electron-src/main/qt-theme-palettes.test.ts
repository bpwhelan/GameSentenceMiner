import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildOverlayTheme } from '../../scripts/sync-overlay-theme.mjs';
import { buildQtThemePalettes } from '../../scripts/qt-theme-palettes.mjs';
import { THEMES } from '../renderer/src/lib/theme.js';

describe('Qt palettes shared with the desktop', () => {
    it('converts OKLCH colors and sRGB mixes into native Qt colors', () => {
        const palettes = buildQtThemePalettes(`
            :root {
                --gsm-surface-0: var(--color-base-100);
                --gsm-surface-1: var(--color-base-200);
                --gsm-accent: var(--color-primary);
                --gsm-accent-soft: color-mix(in srgb, var(--color-primary) 15%, var(--color-base-100));
            }
            [data-theme=gsm-dark] {
                color-scheme: dark;
                --color-base-100: oklch(0% 0 0);
                --color-base-200: oklch(50% 0 0);
                --color-primary: oklch(100% 0 0);
            }
        `);
        expect(palettes['gsm-dark']).toMatchObject({
            'surface-0': '#000000', 'surface-1': '#636363', accent: '#ffffff', 'accent-soft': '#262626',
        });
    });

    it('exports every theme in the desktop picker from the compiled theme source', async () => {
        const palettes = buildQtThemePalettes(await buildOverlayTheme());
        for (const theme of THEMES) {
            expect(palettes[theme.id], theme.id).toBeDefined();
        }
        expect(palettes['gsm-dark']['surface-0']).toBe('#1a1a1a');
        expect(palettes['gsm-dark'].accent).toBe('#7aa2ff');
        expect(palettes['solarized-light']['surface-0']).toBe('#fdf6e3');
        expect(palettes['high-contrast'].accent).toBe('#ffe000');
        for (const palette of Object.values(palettes) as Array<Record<string, string>>) {
            for (const [key, value] of Object.entries(palette)) {
                if (key !== 'scheme' && key !== 'id') expect(value).toMatch(/^#[0-9a-f]{6}$/);
            }
        }
        expect(JSON.parse(await fs.readFile('GameSentenceMiner/assets/qt_themes.json', 'utf8'))).toEqual(palettes);
    });
});
