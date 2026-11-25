// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MiningSettings } from './MiningSettings';

const invoke = vi.fn();
const profiles = [{ name: 'Default', parent: null, scenes: [] }];

function makeField(path: string, value: unknown, extra: Record<string, unknown> = {}) {
    return {
        path,
        value,
        pinned: false,
        baseValue: value,
        options: [],
        range: null,
        ...extra,
    };
}

let node: HTMLDivElement;
let root: Root;
let currentFields: ReturnType<typeof makeField>[];
let ankiModelFields: string[] = [];
let animatedLockFps: number | null = null;

function buildRichFields() {
    return [
        makeField('general.native_language', 'en', { options: ['en', 'ja'] }),
        makeField('general.target_language', 'ja', { options: ['en', 'ja'] }),
        makeField('general.use_websocket', true),
        makeField('general.use_clipboard', false),
        makeField('general.single_port', 7275, { global: true, range: [1, 65535] }),
        makeField('general.websocket_sources', []),
        makeField('discord.enabled', true, { global: true }),
        makeField('discord.inactivity_timer', 300, { global: true, range: [120, 900] }),
        makeField('discord.icon', 'GSM', { global: true, options: ['GSM', 'Cute', 'Jacked', 'Cursed'] }),
        makeField('anki.enabled', true),
        makeField('anki.url', 'http://127.0.0.1:8765', { global: true }),
        makeField('anki.note_type', 'Custom'),
        makeField('anki.word.name', 'Word'),
        makeField('anki.word.overwrite', true),
        makeField('anki.word.append', false),
        makeField('anki.sentence.name', 'Sent'),
        makeField('anki.sentence.overwrite', true),
        makeField('anki.sentence.append', false),
        makeField('anki.sentence_audio.name', 'Audio'),
        makeField('anki.sentence_audio.overwrite', true),
        makeField('anki.sentence_audio.append', false),
        makeField('anki.picture.name', 'Pic'),
        makeField('anki.picture.overwrite', true),
        makeField('anki.picture.append', false),
        makeField('anki.video.name', ''),
        makeField('anki.sentence_furigana.name', ''),
        makeField('anki.game_name.name', ''),
        makeField('anki.show_update_confirmation_dialog_v2', true),
        makeField('anki.skip_confirmation_for_unvoiced', false),
        makeField('anki.auto_accept_timer', 0),
        makeField('anki.confirmation_always_on_top', true),
        makeField('anki.confirmation_audio_step', 0.25),
        makeField('anki.confirmation_gamepad_enabled', false),
        makeField('anki.confirmation_gamepad_activate', '0'),
        makeField('anki.autoplay_audio', false),
        makeField('features.full_auto', true),
        makeField('features.review_after_session.enabled', false),
        makeField('features.review_after_session.max_future_context_lines', 3, { range: [0, 100] }),
        makeField('screenshot.enabled', true),
        makeField('screenshot.animated', false),
        makeField('screenshot.animated_settings.fps', 15, { range: [10, 30] }),
        makeField('screenshot.animated_settings.target_size_kb', 0, { range: [0, 102400] }),
        makeField('screenshot.animated_settings.size_priority', 'balanced', {
            options: ['balanced', 'prefer_fps', 'prefer_quality'],
        }),
        makeField('screenshot.animated_settings.only_when_voice', false),
        makeField('screenshot.animated_settings.adaptive_avif', false),
        makeField('audio.enabled', true),
        makeField('audio.beginning_offset', -0.5),
        makeField('audio.pre_vad_end_offset', 0.0),
        makeField('audio.end_offset', 0.5),
        makeField('audio.ffmpeg_reencode_options', '-c:a {encoder} -f {format} -af "afade=t=in:d=0.005"'),
        makeField('audio.custom_encode_settings', ''),
        makeField('vad.do_vad_postprocessing', true),
        makeField('vad.trim_beginning', false),
        makeField('vad.beginning_offset', -0.25),
        makeField('vad.use_tts_as_fallback', false),
        makeField('vad.tts_url', 'http://127.0.0.1:5050/?term=$s', { global: true }),
        makeField('hotkeys.pause_text_intake', 'ctrl+p'),
        makeField('hotkeys.pause_text_intake_gamepad', '9'),
        makeField('ai.provider', 'Gemini', {
            options: ['Gemini', 'Groq', 'OpenAI', 'Ollama', 'LM Studio', 'DeepL'],
        }),
        makeField('ai.gemini_model', 'gemini-3.5-flash-lite'),
        makeField('ai.gemini_api_key', '', { global: true }),
        makeField('ai.groq_model', 'openai/gpt-oss-120b'),
        makeField('ai.groq_api_key', '', { global: true }),
        makeField('ai.anki_field', ''),
        makeField('ai.prompt_preset', '', {
            options: ['', 'translation', 'sentence', 'grammar', 'vocabulary', 'nuance', 'context'],
        }),
        makeField('ai.use_canned_translation_prompt', true),
        makeField('ai.use_canned_context_prompt', false),
        makeField('ai.custom_prompt', ''),
        makeField('ai.custom_full_prompt', ''),
        makeField('process_pausing.enabled', false),
        makeField('process_pausing.require_game_exe_match', true),
        makeField('process_pausing.auto_resume_seconds', 30, { range: [5, 300] }),
        makeField('advanced.dont_collect_stats', false),
    ];
}

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    currentFields = buildRichFields();
    ankiModelFields = [];
    animatedLockFps = null;
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, input) => {
        if (channel === 'settings.mining.ready' || channel === 'settings.mining.close') return null;
        if (channel === 'settings.mining.navigation') return null;
        if (channel === 'settings.mining.ankiChoices') {
            return input?.model ? ankiModelFields : ['Lapis', 'Custom'];
        }
        if (channel === 'obs.getScenes') return [];
        if (input?.view === 'obs') {
            return {
                target: 'Default',
                active: 'Default',
                profiles,
                animatedLockFps,
                fields: [
                    makeField('obs.host', '127.0.0.1', { global: true }),
                    makeField('obs.recording_fps', 15, { range: [1, 120] }),
                    makeField('obs.disable_recording', false),
                ],
                migrationBackup: null,
                migrationProfile: null,
            };
        }
        return {
            target: 'Default',
            active: 'Default',
            profiles,
            fields: currentFields,
            migrationBackup: null,
            migrationProfile: null,
        };
    });
    Object.defineProperty(window, 'ipcRenderer', {
        configurable: true,
        value: {
            invoke,
            on: () => () => {},
        },
    });
    node = document.createElement('div');
    document.body.appendChild(node);
    root = createRoot(node);
});

afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
});

const render = (obsOnly = false) =>
    act(async () => {
        root.render(
            <I18nProvider>
                <MiningSettings obsOnly={obsOnly} />
            </I18nProvider>,
        );
    });

const clickButton = (text: string) =>
    act(async () => {
        const btn = [...node.querySelectorAll('button')].find(
            (b) => b.textContent?.trim() === text,
        );
        expect(btn, `Button "${text}" not found`).toBeDefined();
        btn!.click();
    });

const setInputValue = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });

describe('MiningSettings Qt rules parity', () => {
    it('shows only the active AI provider fields and updates setup guide dynamically', async () => {
        await render();
        await clickButton('AI and translation');
        expect(document.getElementById('mining-field-ai.gemini_api_key')).toBeTruthy();
        expect(document.getElementById('mining-field-ai.groq_api_key')).toBeNull();
        expect(node.textContent).toContain('Connect Gemini');
        expect(node.textContent).toContain('Needs key / model');

        const providerSelect = document.getElementById('mining-field-ai.provider') as HTMLSelectElement;
        await setInputValue(providerSelect, 'Groq');
        expect(document.getElementById('mining-field-ai.gemini_api_key')).toBeNull();
        expect(document.getElementById('mining-field-ai.groq_api_key')).toBeTruthy();
        expect(node.textContent).toContain('Connect Groq');

        const groqKey = document.getElementById('mining-field-ai.groq_api_key') as HTMLInputElement;
        await setInputValue(groqKey, 'gsk_test_key');
        expect(node.textContent).toContain('Configured');
    });

    it('enforces AI prompt preset disablement, copy-to-custom, {sentence} validation, and local preview', async () => {
        await render();
        await clickButton('AI and translation');
        await clickButton('Prompts');

        const preset = document.getElementById('mining-field-ai.prompt_preset') as HTMLSelectElement;
        const customPrompt = document.getElementById('mining-field-ai.custom_prompt') as HTMLTextAreaElement;
        const cannedTrans = document.getElementById('mining-field-ai.use_canned_translation_prompt') as HTMLInputElement;
        expect(customPrompt.disabled).toBe(false);

        await setInputValue(preset, 'sentence');
        expect(customPrompt.disabled).toBe(true);
        expect(cannedTrans.disabled).toBe(true);

        await clickButton('Copy selected preset to custom prompt');
        expect(preset.value).toBe('');
        expect(cannedTrans.checked).toBe(false);
        expect(customPrompt.value).toContain('{native_language}');

        const fullPrompt = document.getElementById('mining-field-ai.custom_full_prompt') as HTMLTextAreaElement;
        await setInputValue(fullPrompt, 'No placeholder here');
        expect(node.textContent).toContain('Add {sentence} to this template');
        expect(node.querySelector('.mining-save-notice')).toBeTruthy();

        await clickButton('Prompt Template Builder');
        await clickButton('Load default full template');
        expect(fullPrompt.value).toContain('{sentence}');
        expect(node.querySelector('.mining-save-notice')).toBeNull();
        await clickButton('Close');

        await clickButton('Preview prompt (no API request)');
        expect(node.querySelector('.mining-prompt-preview-box')?.textContent).toContain('昨日は忙しかったけど');
    });

    it('enforces Screenshot animated visibility and target size / adaptive AVIF dependencies', async () => {
        await render();
        await clickButton('Screenshots');
        expect(document.getElementById('mining-field-screenshot.animated_settings.fps')).toBeNull();

        const animToggle = document.getElementById('mining-field-screenshot.animated') as HTMLInputElement;
        await act(async () => animToggle.click());

        const targetSize = document.getElementById('mining-field-screenshot.animated_settings.target_size_kb') as HTMLInputElement;
        const priority = document.getElementById('mining-field-screenshot.animated_settings.size_priority') as HTMLSelectElement;
        const adaptive = document.getElementById('mining-field-screenshot.animated_settings.adaptive_avif') as HTMLInputElement;

        expect(targetSize.disabled).toBe(false);
        expect(priority.disabled).toBe(true);
        expect(adaptive.disabled).toBe(false);

        await setInputValue(targetSize, '250');
        expect(priority.disabled).toBe(false);
        expect(adaptive.disabled).toBe(true);
    });

    it('enforces Anki Confirmation mode switching, auto-accept timer, and gamepad grid toggle', async () => {
        await render();
        await clickButton('Anki');
        await clickButton('Confirmation');

        expect(document.getElementById('mining-field-anki.skip_confirmation_for_unvoiced')).toBeTruthy();
        expect(document.getElementById('mining-field-anki.confirmation_gamepad_activate')).toBeNull();

        const gamepadCheck = document.getElementById('mining-field-anki.confirmation_gamepad_enabled') as HTMLInputElement;
        await act(async () => gamepadCheck.click());
        expect(document.getElementById('mining-field-anki.confirmation_gamepad_activate')).toBeTruthy();

        const autoAcceptNum = document.getElementById('mining-field-anki.auto_accept_timer') as HTMLInputElement;
        expect(autoAcceptNum.disabled).toBe(true);
        const autoAcceptToggle = node.querySelector<HTMLInputElement>('input[aria-label="Enable auto-accept timer"]')!;
        await act(async () => autoAcceptToggle.click());
        expect(autoAcceptNum.disabled).toBe(false);
        expect(autoAcceptNum.value).toBe('10');

        const afterRadio = [...node.querySelectorAll<HTMLInputElement>('input[name="anki-confirmation-mode"]')][1];
        await act(async () => afterRadio.click());
        expect(document.getElementById('mining-field-anki.skip_confirmation_for_unvoiced')).toBeNull();
        expect(document.getElementById('mining-field-features.review_after_session.max_future_context_lines')).toBeTruthy();
        expect(document.getElementById('mining-field-anki.autoplay_audio')).toBeTruthy();
    });

    it('enforces Anki overwrite/append exclusivity and suggests field mappings for Lapis note types', async () => {
        ankiModelFields = [
            'Expression',
            'Sentence',
            'SentenceAudio',
            'Picture',
            'SentenceFurigana',
            'MiscInfo',
            'SentenceTranslation',
        ];
        await render();
        await clickButton('Anki');

        expect(document.getElementById('mining-field-anki.word.overwrite')).toBeNull();
        const sentOverwrite = document.getElementById('mining-field-anki.sentence.overwrite') as HTMLInputElement;
        const sentAppend = document.getElementById('mining-field-anki.sentence.append') as HTMLInputElement;
        expect(sentOverwrite.checked).toBe(true);
        expect(sentAppend.disabled).toBe(true);

        const noteType = document.getElementById('mining-field-anki.note_type') as HTMLInputElement;
        vi.useFakeTimers();
        try {
            await setInputValue(noteType, 'Lapis');
            // Run the field lookup debounce before the separate draft autosave.
            await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
        } finally {
            vi.useRealTimers();
        }
        expect(node.textContent).toContain('Suggested field mappings for "Lapis"');
        await clickButton('Update fields');
        expect((document.getElementById('mining-field-anki.word.name') as HTMLInputElement).value).toBe('Expression');
        expect((document.getElementById('mining-field-anki.sentence.name') as HTMLInputElement).value).toBe('Sentence');
    });

    it('places pre_vad_end_offset on Audio and end_offset on VAD, with FFmpeg presets and conditional disables', async () => {
        await render();
        await clickButton('Audio');
        expect(document.getElementById('mining-field-audio.pre_vad_end_offset')).toBeTruthy();
        expect(document.getElementById('mining-field-audio.end_offset')).toBeNull();

        const preset = document.getElementById('mining-audio-ffmpeg-preset') as HTMLSelectElement;
        await setInputValue(preset, 'none');
        expect((document.getElementById('mining-field-audio.ffmpeg_reencode_options') as HTMLTextAreaElement).value).toBe('');

        await clickButton('Voice detection');
        expect(document.getElementById('mining-field-audio.end_offset')).toBeTruthy();
        expect((document.getElementById('mining-field-vad.beginning_offset') as HTMLInputElement).disabled).toBe(true);
        expect((document.getElementById('mining-field-vad.tts_url') as HTMLInputElement).disabled).toBe(true);
    });

    it('hides secondary Discord fields when Discord presence is disabled', async () => {
        await render();
        await clickButton('General');
        await clickButton('Discord');
        expect(document.getElementById('mining-field-discord.icon')).toBeTruthy();

        const toggle = document.getElementById('mining-field-discord.enabled') as HTMLInputElement;
        await act(async () => toggle.click());
        expect(document.getElementById('mining-field-discord.icon')).toBeNull();
    });

    it('records and clears keyboard hotkeys and renders readable gamepad labels', async () => {
        await render();
        await clickButton('Hotkeys');
        const kb = document.getElementById('mining-field-hotkeys.pause_text_intake') as HTMLInputElement;
        const gp = document.getElementById('mining-field-hotkeys.pause_text_intake_gamepad') as HTMLSelectElement;
        expect(gp.options[gp.selectedIndex].textContent).toBe('Start');

        await act(async () => {
            kb.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, shiftKey: true, bubbles: true }));
        });
        expect(kb.value).toBe('ctrl+shift+m');

        await act(async () => {
            kb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(kb.value).toBe('');
    });

    it('gates Game Pausing and Disable Stats with safety modals and locks require_game_exe_match', async () => {
        await render();
        await clickButton('Features');
        await clickButton('Game pausing');

        const exeMatch = document.getElementById('mining-field-process_pausing.require_game_exe_match') as HTMLInputElement;
        expect(exeMatch.disabled).toBe(true);

        const pauseToggle = document.getElementById('mining-field-process_pausing.enabled') as HTMLInputElement;
        await act(async () => pauseToggle.click());
        expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain('Enable Game Pausing?');
        await clickButton('Cancel');
        expect(pauseToggle.checked).toBe(false);

        await act(async () => pauseToggle.click());
        await clickButton('Enable Game Pausing');
        expect(pauseToggle.checked).toBe(true);

        await clickButton('Advanced');
        const statsToggle = document.getElementById('mining-field-advanced.dont_collect_stats') as HTMLInputElement;
        await act(async () => statsToggle.click());
        expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain('Completely Disable Stats Collection?');
        await clickButton('Cancel');
        expect(statsToggle.checked).toBe(false);
    });

    it('displays dynamic OBS FPS status banners including Animated FPS lock', async () => {
        animatedLockFps = 20;
        await render(true);
        await clickButton('Recording');
        expect(node.textContent).toContain('Locked by Animated Screenshot FPS');

        const fpsInput = document.getElementById('mining-field-obs.recording_fps') as HTMLInputElement;
        await setInputValue(fpsInput, '60');
        expect(node.textContent).toContain('High FPS warning');
    });
});
