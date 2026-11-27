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
type Destination = { root: string; subtab: string };
let pinned: boolean;
let audioEnabled: boolean;
let active: string;
let beforeApply: () => void | Promise<void>;

beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    listeners.clear();
    pinned = false;
    audioEnabled = true;
    active = 'Game';
    beforeApply = () => {};
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, input) => {
        if (channel === 'settings.mining.ankiChoices') return input.model ? ['Expression', 'Sentence'] : ['Mining'];
        if (channel === 'settings.mining.apply') {
            await beforeApply();
            for (const edit of input.changes ?? []) {
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
                          { ...field, path: 'obs.recording_fps', global: true, value: 30 },
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
const render = (destination?: Destination, active = true) =>
    act(async () => {
        root.render(
            <I18nProvider>
                <MiningSettings active={active} destination={destination} />
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

it('manages the selected profile directly from the Mining header', async () => {
    await render();
    const action = (label: string) => node.querySelector<HTMLButtonElement>(`header [aria-label="${label}"]`)!;
    await act(async () => action('New profile').click());
    expect(node.querySelector('.mining-manage select')).toBeTruthy();
    await click('New scene profile');
    expect(node.querySelector('.mining-manage input[list="mining-scenes"]')).toBeTruthy();
    await act(async () => action('Rename profile').click());
    const name = node.querySelector<HTMLInputElement>('.mining-manage input')!;
    expect(name.value).toBe('Game');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'My game');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Rename profile');
    expect(applyCalls().at(-1)?.[1]).toEqual({ op: 'rename', view: 'mining', target: 'Game', name: 'My game' });
    await act(async () => action('Delete profile').click());
    expect(node.textContent).toContain('Remove settings for Game?');
    await click('Cancel');
    expect(applyCalls()).toHaveLength(1);
    await act(async () => {
        const picker = node.querySelector<HTMLSelectElement>('#mining-target')!;
        picker.value = '"VN"';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(action('Delete profile').disabled).toBe(true);
    expect(action('Rename profile').disabled).toBe(false);
});

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
    await render({ root: 'anki', subtab: 'tags' });
    expect(node.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Tags');
    expect(document.getElementById('mining-field-anki.custom_tags')).toBeTruthy();
    expect((document.getElementById('mining-search') as HTMLInputElement).value).toBe('');
});

it('follows a queued shortcut after autosaving and keeps the selected profile', async () => {
    await render();
    await click('Audio');
    await click('Keep this value');
    await render({ root: 'key_settings', subtab: '' });
    expect(node.querySelector<HTMLSelectElement>('#mining-target')?.value).toBe('"Game"');
    await advance();
    expect(node.querySelector<HTMLSelectElement>('#mining-target')?.value).toBe('"Game"');
    expect(node.querySelector('h2')?.textContent).toBe('Key Settings');
});
it('flushes edits when leaving Mining and releases desktop keyboard shortcuts', async () => {
    await render();
    await click('Audio');
    await toggleAudio();
    await render(undefined, false);
    await advance(0);
    expect(applyCalls()).toHaveLength(1);
    expect(audioEnabled).toBe(false);
    const find = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true });
    window.dispatchEvent(find);
    expect(find.defaultPrevented).toBe(false);
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
    await render(undefined, false);
    await render();
    await click('Discard');
    await click('Key Settings');
    const restored = document.getElementById('mining-field-general.single_port') as HTMLInputElement;
    expect(restored.getAttribute('aria-invalid')).not.toBe('true');
    expect(restored.value).toBe('7275');
});

it('edits OBS connections and recording in the hub without registering a second settings window', async () => {
    await act(async () =>
        root.render(
            <I18nProvider>
                <MiningSettings obsOnly />
            </I18nProvider>,
        ),
    );
    expect(invoke).toHaveBeenCalledWith('settings.mining.read', { view: 'obs', target: null });
    expect(node.querySelector('.mining-scope-picker')).toBeNull();
    expect(invoke.mock.calls.some(([channel]) => channel === 'settings.mining.ready')).toBe(false);
    expect(node.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('local');
    await click('Recording');
    const fps = document.getElementById('mining-field-obs.recording_fps') as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fps, '24');
        fps.dispatchEvent(new Event('input', { bubbles: true }));
    });
    active = 'VN';
    await act(async () => listeners.get('settings.mining.changed')!());
    await advance();
    expect(applyCalls()[0][1]).toMatchObject({
        op: 'edit', view: 'obs', target: null,
        changes: [{ path: 'obs.recording_fps', before: 30, value: 24, pinned: false }],
    });
    expect(node.querySelector('nav')).toBeNull();
});

it('offers AnkiConnect note types and the fields for the selected model on Key Settings', async () => {
    await render();
    expect(document.getElementById('mining-field-anki.note_type')?.querySelector<HTMLOptionElement>('option[value="Mining"]')?.value).toBe('Mining');
    await advance(300);
    expect(invoke).toHaveBeenCalledWith('settings.mining.ankiChoices', {model:'Mining'});
    expect(document.getElementById('mining-field-anki.sentence.name')?.querySelector<HTMLOptionElement>('option[value="Expression"]')?.value).toBe('Expression');
});
