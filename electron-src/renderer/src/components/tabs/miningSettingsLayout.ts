// The Qt Key Settings page is a second view of the same fields. Edits stay keyed
// by their canonical path when switching between this page and a detailed tab.
export const keySettings = [
    'general.native_language',
    'general.target_language',
    'general.use_websocket',
    'general.use_clipboard',
    'general.single_port',
    'general.websocket_sources',
    'anki.note_type',
    'anki.word.name',
    'anki.sentence.name',
    'anki.sentence_audio.name',
    'anki.picture.name',
    'audio.beginning_offset',
    'audio.end_offset',
    'features.open_anki_edit',
    'features.open_anki_in_browser',
];

export const categories: Record<string, string[]> = {
    key_settings: [],
    general: ['general', 'paths', 'discord'],
    features: ['general', 'tokenization', 'process_pausing'],
    anki: ['general', 'confirmation', 'field_grouping', 'tags'],
    screenshot: ['general'],
    audio: ['audio', 'vad'],
    hotkeys: ['general'],
    ai: ['general', 'prompts', 'gsm_cloud'],
    advanced: ['general', 'network', 'stats'],
    obs: ['connection', 'recording'],
};

export function fieldPage(path: string): [string, string] {
    const [group, key] = path.split('.');
    switch (group) {
        case 'obs':
            return [
                'obs',
                /^(host|port|password|obs_path|open_obs|close_obs|allow_automatic_updates|disable_desktop_audio_on_connect)$/.test(
                    key,
                )
                    ? 'connection'
                    : 'recording',
            ];
        case 'paths':
        case 'discord':
            return ['general', group];
        case 'anki':
            if (key.startsWith('confirmation_gamepad_')) return ['hotkeys', 'general'];
            if (key === 'polling_rate_v2') return ['advanced', 'general'];
            if (
                key.includes('confirmation') ||
                key === 'auto_accept_timer' ||
                key === 'autoplay_audio' ||
                key === 'replay_audio_on_tts_generation'
            )
                return ['anki', 'confirmation'];
            if (key.startsWith('field_grouping')) return ['anki', 'field_grouping'];
            return ['anki', key.includes('tag') ? 'tags' : 'general'];
        case 'features':
            if (key.startsWith('open_anki_') || key === 'browser_query') return ['anki', 'general'];
            if (key === 'review_after_session') return ['anki', 'confirmation'];
            return ['features', 'general'];
        case 'experimental':
            return ['features', 'tokenization'];
        case 'process_pausing':
            return ['features', 'process_pausing'];
        case 'audio':
            // Matches Qt tabs/audio.py & tabs/vad.py:
            // pre_vad_end_offset lives on Audio -> Audio; end_offset lives on Audio -> VAD (and Key Settings).
            return ['audio', key === 'end_offset' ? 'vad' : 'audio'];
        case 'vad':
            return ['audio', 'vad'];
        case 'ai':
            return [
                'ai',
                key.includes('prompt')
                    ? 'prompts'
                    : key.startsWith('gsm_cloud_')
                      ? 'gsm_cloud'
                      : 'general',
            ];
        case 'stats':
            return ['advanced', 'stats'];
        case 'advanced':
            if (key === 'multi_line_line_break') return ['anki', 'general'];
            if (key.startsWith('mute_game_')) return ['features', 'general'];
            return [
                'advanced',
                key.startsWith('cloud_sync_')
                    ? 'sync'
                    : /port$|bind_address$/.test(key)
                      ? 'network'
                      : 'general',
            ];
        case 'hotkeys':
            return ['hotkeys', 'general'];
        case 'screenshot':
            return ['screenshot', 'general'];
        case 'profiles':
        case 'switch_to_default_if_not_found':
            return ['profiles', 'general'];
        default:
            return [group, 'general'];
    }
}

export function destinationPage(root: string, subtab: string): [string, string] {
    switch (root) {
        case 'experimental':
            return ['features', 'tokenization'];
        case 'discord':
        case 'paths':
            return ['general', root];
        case 'vad':
            return ['audio', root];
        case 'tokenization':
            return ['features', 'tokenization'];
        case 'game_pausing':
        case 'process_pausing':
            return ['features', 'process_pausing'];
        case 'session_review':
            return ['anki', 'confirmation'];
        case 'gsm_cloud':
            return ['ai', 'gsm_cloud'];
        default:
            return [root || 'key_settings', subtab];
    }
}

// Put setup controls before secondary options on the detailed pages.
const leadingFields: Record<string, string[]> = {
    'anki.general': [
        'anki.enabled',
        'anki.url',
        'anki.note_type',
        ...[
            'word',
            'sentence',
            'sentence_audio',
            'picture',
            'previous_sentence',
            'previous_image',
            'video',
            'sentence_furigana',
            'game_name',
        ].map((key) => 'anki.' + key + '.name'),
    ],
    'anki.confirmation': [
        'anki.show_update_confirmation_dialog_v2',
        'anki.skip_confirmation_for_unvoiced',
        'anki.auto_accept_timer',
    ],
    'general.general': keySettings.filter((key) => key.startsWith('general.')),
    'audio.audio': [
        'audio.enabled',
        'audio.extension',
        'audio.beginning_offset',
        'audio.pre_vad_end_offset',
    ],
    'audio.vad': ['vad.do_vad_postprocessing', 'vad.selected_vad_model_v2', 'vad.backup_vad_model', 'audio.end_offset'],
    'ai.general': ['ai.provider', 'ai.enabled'],
    'obs.connection': [
        'obs.open_obs',
        'obs.close_obs',
        'obs.allow_automatic_updates',
        'obs.obs_path',
        'obs.host',
        'obs.port',
        'obs.password',
    ],
    'obs.recording': [
        'obs.disable_recording',
        'obs.recording_fps',
        'obs.replay_buffer_enabled',
        'obs.automatically_manage_replay_buffer',
        'obs.replay_buffer_duration_seconds',
    ],
    'screenshot.general': [
        'screenshot.enabled',
        'screenshot.quality',
        'screenshot.extension',
        'screenshot.animated',
    ],
};
export function orderFields<T extends { path: string }>(rows: T[], group: string, tab: string) {
    const order = leadingFields[group + '.' + tab];
    if (!order) return rows;
    const rank = (path: string) => {
        const i = order.indexOf(path);
        return i < 0 ? order.length : i;
    };
    return [...rows].sort((a, b) => rank(a.path) - rank(b.path));
}
