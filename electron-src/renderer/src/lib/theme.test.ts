import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES } from './theme';

describe('shared app and overlay palettes', () => {
  it('ships the current theme definitions for every desktop theme', async () => {
    const generator = await import(pathToFileURL(resolve('scripts/sync-overlay-theme.mjs')).href);
    const shipped = await readFile(resolve('GSM_Overlay/settings/app-theme.css'), 'utf8');
    expect(shipped).toBe(await generator.buildOverlayTheme());
    for (const theme of THEMES) {
      expect(shipped).toMatch(new RegExp(`\\[data-theme="?${theme.id}"?\\]`));
    }
  });
});
