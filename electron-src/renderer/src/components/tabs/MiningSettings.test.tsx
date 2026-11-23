// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MiningSettings } from './MiningSettings';

const invoke = vi.fn();
const profiles = [
    { name: 'VN', parent: null, scenes: ['Game'] },
    { name: 'Game', parent: 'VN', scenes: ['Game'] },
];
const field = {
    path: 'audio.enabled',
    value: true,
    pinned: false,
    baseValue: true,
    options: [],
    range: null,
};
let node: HTMLDivElement;
let root: Root;
const listeners = new Map<string, () => void>();
let destination: { root: string; subtab: string } | null;
let pinned: boolean;
let audioEnabled: boolean;
let active: string;
let beforeApply: () => void | Promise<void>;

beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    listeners.clear();
    destination = null;
    pinned = false;
    audioEnabled = true;
    active = 'Game';
    beforeApply = () => {};
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, input) => {
        if (channel === 'settings.mining.ready' || channel === 'settings.mining.close') return null;
        if (channel === 'settings.mining.navigation') return destination;
        if (channel === 'settings.mining.ankiChoices') return input.model ? ['Expression', 'Sentence'] : ['Mining'];
        if (channel === 'settings.mining.apply') {
            await beforeApply();
            for (const edit of input.changes) {
                if (edit.path === field.path) {
                    pinned = !edit.inherit;
                    audioEnabled = edit.inherit ? true : edit.value;
                }
            }
        }
        const target = input.target === undefined ? active : input.target;
        return {
            target,
            active,
            profiles,
            fields:
                input.view === 'obs'
                    ? [
                          { ...field, path: 'obs.password', global: true, value: 'local' },
                          { ...field, path: 'obs.recording_fps', value: 30 },
                      ]
                    : target === null
                      ? [{ ...field, path: 'ai.api_key', value: 'private' }]
                      : [
                            { ...field, pinned, value: audioEnabled },
                            { ...field, path: 'general.single_port', global: true, value: 7275 },
                            { ...field, path:'anki.url', global:true, value:'http://127.0.0.1:8765' },
                          { ...field, path:'anki.note_type', value:'Mining' },
                          { ...field, path: 'anki.sentence.name', value: 'Sentence' },
                            { ...field, path: 'anki.custom_tags', value: [] },
                            { ...field, path: 'overlay.enabled' },
                            { ...field, path: 'obs.open_obs' },
                            { ...field, path: 'text_processing.remove_numbers' },
                        ],
        };
    });
    Object.defineProperty(window, 'ipcRenderer', {
        configurable: true,
        value: {
            invoke,
            on: (channel: string, fn: () => void) => {
                listeners.set(channel, fn);
                return () => listeners.delete(channel);
            },
        },
    });
    node = document.createElement('div');
    document.body.appendChild(node);
    root = createRoot(node);
});
afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    node.remove();
});
const render = () =>
    act(async () => {
        root.render(
            <I18nProvider>
                <MiningSettings />
            </I18nProvider>,
        );
    });
const click = (name: string) =>
    act(async () => {
        const button = [...node.querySelectorAll('button')].find(
            (b) => b.textContent === name || b.getAttribute('aria-label')?.startsWith(name + ' · '),
        );
        expect(button).toBeDefined();
        button!.click();
    });
const advance = (ms = 500) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const toggleAudio = () =>
    act(async () => document.getElementById('mining-field-audio.enabled')!.click());
const applyCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'settings.mining.apply');

it('pins an unchanged value and returns it to inheritance without changing the active game', async () => {
    await render();
    await click('Audio');
    expect(node.textContent).toContain('From VN');
    await click('Keep this value');
    await advance();
    expect(invoke).toHaveBeenCalledWith(
        'settings.mining.apply',
        expect.objectContaining({
            target: 'Game',
            changes: [
                expect.objectContaining({
                    path: 'audio.enabled',
                    pinned: false,
                    before: true,
                    value: true,
                }),
            ],
        }),
    );
    await click('Use profile value');
    await advance();
    expect(node.textContent).toContain('From VN');
    expect(applyCalls()).toHaveLength(2);
});
it('keeps an edit addressed to its original game across a live profile switch', async () => {
    await render();
    await click('Audio');
    await toggleAudio();
    active = 'VN';
    await act(async () => listeners.get('settings.mining.changed')!());
    expect(node.querySelector('#mining-target')?.getAttribute('title')).toBe('Active in GSM · VN');
    expect(node.querySelector<HTMLSelectElement>('#mining-target')?.disabled).toBe(true);
    await advance();
    expect(invoke).toHaveBeenCalledWith(
        'settings.mining.apply',
        expect.objectContaining({
            target: 'Game',
            changes: [expect.objectContaining({ value: false, before: true })],
        }),
    );
});
it('edits global credentials in a masked input', async () => {
    await render();
    await act(async () => {
        const combo = node.querySelector<HTMLSelectElement>('#mining-target')!;
        combo.value = 'null';
        combo.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(node.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('private');
    expect(node.textContent).not.toContain('private');
});

it('exposes categories directly in the settings window', async () => {
    await render();
    expect(node.querySelector('nav')?.textContent).toContain('Audio');
    expect(node.querySelector('h1')?.textContent).toBe('Mining settings');
    expect(node.querySelector('h2')?.textContent).toBe('Key Settings');
    expect(node.querySelector('nav')?.textContent).not.toMatch(/Overlay|Text processing|OBS/);
    const row = document
        .getElementById('mining-field-general.single_port')!
        .closest('.mining-row')!;
    expect(row.textContent).toContain('Global');
    expect(row.textContent).not.toContain('From VN');
    expect(row.querySelector('[data-tip]')?.getAttribute('data-tip')).toContain('Restart GSM');
    expect(row.textContent).not.toContain('Restart GSM');
    expect(document.getElementById('mining-field-anki.sentence.name')).toBeTruthy();
    destination = { root: 'anki', subtab: 'tags' };
    await act(async () => listeners.get('settings.mining.navigate')!());
    expect(node.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Tags');
    expect(document.getElementById('mining-field-anki.custom_tags')).toBeTruthy();
    expect((document.getElementById('mining-search') as HTMLInputElement).value).toBe('');
});

it('follows a queued shortcut after autosaving and keeps the selected profile', async () => {
    await render();
    await click('Audio');
    await click('Keep this value');
    destination = { root: 'key_settings', subtab: '' };
    await act(async () => listeners.get('settings.mining.navigate')!());
    expect(node.querySelector<HTMLSelectElement>('#mining-target')?.value).toBe('"Game"');
    await advance();
    expect(node.querySelector<HTMLSelectElement>('#mining-target')?.value).toBe('"Game"');
    expect(node.querySelector('h2')?.textContent).toBe('Key Settings');
});
it('closes a clean window immediately', async () => {
    await render();
    await act(async () => listeners.get('settings.mining.requestClose')!());
    expect(invoke).toHaveBeenCalledWith('settings.mining.close');
});

it('flushes edits when closing and waits for them to persist', async () => {
    await render();
    await click('Audio');
    await toggleAudio();
    let finishSave!: () => void;
    beforeApply = () => new Promise<void>((resolve) => { finishSave = resolve; });

    await act(async () => listeners.get('settings.mining.requestClose')!());
    await advance(0);
    expect(applyCalls()).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith('settings.mining.close');
    await act(async () => finishSave());
    expect(invoke).toHaveBeenCalledWith('settings.mining.close');
});

it('preserves and rebases changes made while an autosave is in flight', async () => {
    await render();
    await click('Audio');
    let finishSave!: () => void;
    beforeApply = () => new Promise<void>((resolve) => { finishSave = resolve; });
    await toggleAudio();
    await advance();
    expect(applyCalls()).toHaveLength(1);
    await toggleAudio();
    beforeApply = () => {};
    await act(async () => finishSave());
    await advance();
    expect(applyCalls()[1]?.[1]).toMatchObject({
        target: 'Game',
        changes: [{ path: 'audio.enabled', before: false, value: true, pinned: true }],
    });
    expect(audioEnabled).toBe(true);
});

it('retains rejected edits for retry', async () => {
    await render();
    await click('Audio');
    beforeApply = () => { throw new Error('Disk busy'); };
    await toggleAudio();
    await advance();
    expect(node.querySelector('[role=alert]')?.textContent).toContain('Disk busy');
    expect((document.getElementById('mining-field-audio.enabled') as HTMLInputElement).checked)
        .toBe(false);
    await advance();
    expect(applyCalls()).toHaveLength(1);
    beforeApply = () => {};
    await click('Retry');
    expect(applyCalls()).toHaveLength(2);
    expect(audioEnabled).toBe(false);
    expect(node.querySelector('[role=alert]')).toBeNull();
});

it('autosaves valid edits while an invalid field is still being corrected', async () => {
    await render();
    const port = document.getElementById('mining-field-general.single_port') as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(port, '');
        port.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(port.getAttribute('aria-invalid')).toBe('true');
    await click('Audio');
    await toggleAudio();
    await advance();
    expect(applyCalls()).toHaveLength(1);
    expect(applyCalls()[0][1].changes.map((edit: { path: string }) => edit.path)).toEqual([
        'audio.enabled',
    ]);
    await act(async () => listeners.get('settings.mining.requestClose')!());
    expect(invoke).not.toHaveBeenCalledWith('settings.mining.close');
    await click('Discard and close');
    expect(invoke).toHaveBeenCalledWith('settings.mining.close');
});

it('edits OBS connections and recording in the hub without registering a second settings window', async () => {
    await act(async () =>
        root.render(
            <I18nProvider>
                <MiningSettings obsOnly />
            </I18nProvider>,
        ),
    );
    expect(invoke).toHaveBeenCalledWith('settings.mining.read', { view: 'obs' });
    expect(invoke.mock.calls.some(([channel]) => channel === 'settings.mining.ready')).toBe(false);
    expect(node.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('local');
    await click('Recording');
    expect(document.getElementById('mining-field-obs.recording_fps')).toBeTruthy();
    expect(node.querySelector('nav')).toBeNull();
});

it('offers AnkiConnect note types and the fields for the selected model on Key Settings', async () => {
    await render();
    expect(document.getElementById('mining-field-anki.note_type-choices')?.querySelector('option')?.value).toBe('Mining');
    await advance(300);
    expect(invoke).toHaveBeenCalledWith('settings.mining.ankiChoices', {model:'Mining'});
    expect(document.getElementById('mining-field-anki.sentence.name-choices')?.querySelector('option')?.value).toBe('Expression');
});
