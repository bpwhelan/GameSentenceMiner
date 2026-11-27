import { useEffect, useState } from 'react';
import { useLocale, useTranslation } from '../../i18n';
import { PROCESSOR_META } from '../../lib/textProcessorMetadata';

// Load the existing settings translations and help text only when the editor opens.
type Copy = Record<string, Record<string, string | { label?: string; tooltip?: string }>>;
const dictionaries = import.meta.glob<{ default: { python: { config: { tabs: Copy } } } }>(
    '../../../../../resources/locales/*.json',
);
const localeFiles: Record<string, string> = {
    en: 'en_us',
    ja: 'ja_jp',
    ukr: 'ukr_ua',
    es: 'es_es',
    ko: 'ko_kr',
    zh: 'zh_cn',
};
const aliases: Record<string, string> = {
    'profiles.switch_to_default_if_not_found': 'profiles.switch_to_default',
    'general.use_websocket': 'general.websocket_enabled',
    'general.use_clipboard': 'general.clipboard_enabled',
    'general.use_both_clipboard_and_websocket': 'general.allow_both_simultaneously',
    'general.open_multimine_on_startup': 'general.open_texthooker_on_startup',
    'anki.show_update_confirmation_dialog_v2': 'anki.show_update_confirmation_dialog',
    'features.open_anki_in_browser': 'features.open_anki_browser',
    'screenshot.custom_ffmpeg_settings': 'screenshot.ffmpeg_options',
    'screenshot.seconds_after_line': 'screenshot.offset',
    'screenshot.screenshot_timing_setting': 'screenshot.timing',
    'screenshot.trim_black_bars_wip': 'screenshot.trim_black_bars',
    'audio.ffmpeg_reencode_options': 'audio.ffmpeg_options',
    'audio.pre_vad_end_offset': 'audio.end_offset',
    'audio.end_offset': 'vad.audio_end_offset',
    'obs.get_game_from_scene': 'obs.game_from_scene',
    'obs.automatically_manage_replay_buffer': 'obs.auto_manage_replay_buffer',
    'obs.replay_buffer_duration_seconds': 'obs.replay_buffer_duration',
    'advanced.plaintext_websocket_port': 'advanced.plaintext_export_port',
    'advanced.multi_line_line_break': 'advanced.multiline_linebreak',
    'advanced.texthooker_communication_websocket_port': 'advanced.texthooker_comm_port',
    'advanced.screenshot_capture_backend_v2': 'screenshot.capture_backend',
    'advanced.wgc_capture_fps': 'screenshot.wgc_capture_fps',
    'vad.selected_vad_model_v2': 'vad.selected_model',
    'vad.backup_vad_model': 'vad.backup_model',
    'vad.do_vad_postprocessing': 'vad.do_postprocessing',
    'vad.add_audio_on_no_results': 'vad.add_on_no_results',
    'vad.cut_and_splice_segments': 'vad.cut_and_splice',
    'ai.use_canned_translation_prompt': 'ai.use_canned_translation',
    'ai.use_canned_context_prompt': 'ai.use_canned_context',
    'ai.dialogue_context_length': 'ai.context_length',
    'ai.open_ai_api_key': 'ai.openai_apikey',
    'overlay.engine_v2': 'overlay.overlay_engine',
    'overlay.monitor_to_capture': 'overlay.overlay_monitor',
};
export function fieldGroup(path: string) {
    return path.includes('.') ? path.split('.')[0] : 'profiles';
}
export function useFieldLabels(active: boolean) {
    const [locale] = useLocale();
    const t = useTranslation();
    const [copy, setCopy] = useState<Copy>({});
    useEffect(() => {
        if (!active) return;
        let live = true;
        const load =
            dictionaries[
                '../../../../../resources/locales/' +
                    (localeFiles[locale] || 'en_us') +
                    '.json'
            ];
        void load?.().then((mod) => {
            if (live) setCopy(mod.default.python.config.tabs);
        });
        return () => {
            live = false;
        };
    }, [locale, active]);
    return (path: string) => {
        const parts = path.split('.');
        const key = parts.pop()!;
        const originalGroup = fieldGroup(path);
        let group = originalGroup === 'process_pausing' ? 'game_pausing' : originalGroup;
        let lookup = key;
        if (parts[1] === 'review_after_session') group = 'session_review';
        if (group === 'ai') lookup = key.replace('open_ai_', 'openai_');
        const alias = aliases[originalGroup + '.' + key];
        if (alias) [group, lookup] = alias.split('.');
        const mapping =
            group === 'anki' && parts.length === 2 && key === 'name'
                ? copy.anki?.[parts[1] + '_field']
                : undefined;
        const message = mapping || copy[group]?.[lookup];
        const processor =
            originalGroup === 'text_processing' &&
            PROCESSOR_META.find((p) => p.id === key.replace(/_v2$/, ''));
        const sectionLabel = t('mining.sections.' + originalGroup);
        const custom = 'mining.fields.' + path.replace(/\./g, '_');
        const translated = t(custom);
        const termKey = 'mining.terms.' + key;
        const term = t(termKey);
        const label =
            translated !== custom
                ? translated
                : processor
                  ? t(processor.labelKey)
                  : term !== termKey
                    ? term
                    : typeof message === 'string'
                      ? message
                      : (message?.label ??
                        t('mining.fieldName', {
                            name: key
                                .replace(/_v2$/, '')
                                .replace(/_/g, ' ')
                                .replace(/^./, (c) => c.toUpperCase()),
                        }));
        let name = label.replace(/[:：]\s*$/, '');
        if (mapping && typeof mapping === 'object' && mapping.label)
            name = mapping.label.replace(/[:：]\s*$/, '');
        if (!mapping && parts.length > 1 && group !== 'session_review') {
            const parent = parts.slice(1).join(' ');
            const entry = copy[group]?.[parent + '_field'];
            const parentKey = 'mining.groups.' + parent;
            const parentLabel =
                typeof entry === 'object' && entry.label
                    ? entry.label.replace(/[:：]\s*$/, '')
                    : t(parentKey) === parentKey
                      ? parent.replace(/_/g, ' ')
                      : t(parentKey);
            name = t('mining.nested', { group: parentLabel, field: name });
        }
        return {
            name,
            sectionLabel,
            help: processor
                ? t(processor.descKey)
                : typeof message === 'object'
                  ? message.tooltip
                  : undefined,
        };
    };
}
