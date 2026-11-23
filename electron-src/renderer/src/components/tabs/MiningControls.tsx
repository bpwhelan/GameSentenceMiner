import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ObsScene } from '../../types/models';
import {
    FULL_PROMPT_TEMPLATE,
    PROMPT_PLACEHOLDERS,
    buildContextPrompt,
    buildTranslationPrompt,
} from './miningSettingsRules';

export function MiningIcon({ name, size = 16 }: { name: string; size?: number }) {
    const paths: Record<string, string> = {
        key_settings:
            'M12 3l2.4 5.2L20 9l-4.2 3.8L17 19l-5-2.8L7 19l1.2-6.2L4 9l5.6-.8L12 3Z',
        general:
            'M4 6h16M4 12h16M4 18h10',
        features:
            'M13 3L4 14h7l-1 7 9-11h-7l1-7Z',
        anki:
            'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11ZM8 9h8M8 13h5',
        screenshot:
            'M4 7h3l2-2h6l2 2h3v11H4V7Zm8 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
        audio:
            'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
        hotkeys:
            'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm4 3h2m3 0h2m3 0h1M7 14h10',
        ai: 'M12 3v3m0 12v3M3 12h3m12 0h3m-3.6-6.4-2.1 2.1m-6.6 6.6-2.1 2.1m0-10.8 2.1 2.1m6.6 6.6 2.1 2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
        advanced:
            'M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M10 14v6',
        profiles:
            'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m18 0v-1a4 4 0 0 0-3-3.87M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-6.5a3.5 3.5 0 0 1 0 6.5',
        search: 'M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4.2-4.2',
        folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z',
        external: 'M14 4h6v6m0-6L10 14M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5',
        eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Zm10-2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
        eyeOff: 'M3 3l18 18M10.6 10.6a2.5 2.5 0 0 0 3.5 3.5M9.9 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4.1M6.3 6.3A17.7 17.7 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 4.3-.9',
        refresh: 'M20 6v5h-5M4 18v-5h5m-4-3a8 8 0 0 1 13.7-2.5L20 11M4 13l1.3 3.5A8 8 0 0 0 19 14',
        alert: 'M12 3L2.5 19.5h19L12 3Zm0 6v4.5m0 3h.01',
        info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 7v6m0-9h.01',
        lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v9H5v-9Z',
        clear: 'M6 6l12 12M18 6L6 18',
        check: 'M5 12l4.5 4.5L19 7',
        plus: 'M12 5v14M5 12h14',
        sparkles:
            'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Zm7 12l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z',
        keyboard: 'M3 7h18v10H3V7Zm3 3h2m3 0h2m3 0h2M7 14h10',
        gamepad: 'M6 10h4M8 8v4m7-2h.01M17 12h.01M5 7h14a3 3 0 0 1 2.9 3.7l-1.1 4.5A2.5 2.5 0 0 1 16 15l-1.5-1.5h-5L8 15a2.5 2.5 0 0 1-4.8.2l-1.1-4.5A3 3 0 0 1 5 7Z',
    };
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ width: size, height: size }}
        >
            <path d={paths[name] ?? paths.general} />
        </svg>
    );
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

function formatKeyEvent(event: KeyboardEvent<HTMLInputElement>): string | null {
    if (MODIFIER_KEYS.has(event.key)) return null;
    const parts: string[] = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    if (event.metaKey) parts.push('meta');

    let key = event.key;
    if (key === ' ') key = 'space';
    else if (key === '+') key = 'plus';
    else if (key.startsWith('Arrow')) key = key.slice(5).toLowerCase();
    else if (key.length === 1) key = key.toLowerCase();
    else key = key.toLowerCase();

    parts.push(key);
    return parts.join('+');
}

export function HotkeyInput({
    id,
    value,
    name,
    hint,
    disabled,
    onChange,
}: {
    id: string;
    value: string;
    name: string;
    hint?: string;
    disabled: boolean;
    onChange: (next: string) => void;
}) {
    const t = useTranslation();
    const [recording, setRecording] = useState(false);

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (disabled) return;
        if (event.key === 'Tab') return;
        event.preventDefault();
        event.stopPropagation();

        if (
            (event.key === 'Escape' || event.key === 'Backspace') &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            !event.metaKey
        ) {
            onChange('');
            return;
        }
        const formatted = formatKeyEvent(event);
        if (formatted) {
            onChange(formatted);
        }
    };

    return (
        <div className={'mining-hotkey-wrap' + (recording ? ' is-recording' : '')}>
            <input
                id={id}
                type="text"
                readOnly
                disabled={disabled}
                aria-label={name}
                aria-description={hint}
                value={value}
                placeholder={recording ? t('mining.hotkeyPress') : t('mining.hotkeyUnbound')}
                onFocus={() => setRecording(true)}
                onBlur={() => setRecording(false)}
                onKeyDown={handleKeyDown}
            />
            {value && !disabled && (
                <button
                    type="button"
                    className="mining-icon-btn"
                    aria-label={t('mining.clearHotkey') + ' ' + name}
                    title={t('mining.clearHotkey')}
                    onClick={() => onChange('')}
                >
                    <MiningIcon name="clear" size={13} />
                </button>
            )}
        </div>
    );
}

export function SecretInput({
    id,
    value,
    name,
    hint,
    placeholder,
    disabled,
    onChange,
}: {
    id: string;
    value: string;
    name: string;
    hint?: string;
    placeholder?: string;
    disabled: boolean;
    onChange: (next: string) => void;
}) {
    const t = useTranslation();
    const [revealed, setRevealed] = useState(false);

    return (
        <div className="mining-secret-wrap">
            <input
                id={id}
                type={revealed ? 'text' : 'password'}
                disabled={disabled}
                aria-label={name}
                aria-description={hint}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            <button
                type="button"
                className="mining-icon-btn"
                disabled={disabled}
                aria-label={t(revealed ? 'mining.hideSecret' : 'mining.showSecret')}
                title={t(revealed ? 'mining.hideSecret' : 'mining.showSecret')}
                onClick={() => setRevealed((prev) => !prev)}
            >
                <MiningIcon name={revealed ? 'eyeOff' : 'eye'} size={14} />
            </button>
        </div>
    );
}

export function PathInput({
    id,
    value,
    name,
    hint,
    disabled,
    directory,
    onBrowse,
    onChange,
}: {
    id: string;
    value: string;
    name: string;
    hint?: string;
    disabled: boolean;
    directory: boolean;
    onBrowse: () => void;
    onChange: (next: string) => void;
}) {
    const t = useTranslation();
    return (
        <div className="mining-path-wrap">
            <input
                id={id}
                type="text"
                disabled={disabled}
                aria-label={name}
                aria-description={hint}
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            <button
                type="button"
                className="mining-browse-btn"
                disabled={disabled}
                onClick={onBrowse}
                title={t(directory ? 'mining.browseFolder' : 'mining.browseFile')}
            >
                <MiningIcon name="folder" size={14} />
                <span>{t('mining.browse')}</span>
            </button>
        </div>
    );
}

export function ScenePickerField({
    id,
    value,
    name,
    hint,
    disabled,
    scenes,
    onRefresh,
    onChange,
}: {
    id: string;
    value: string[];
    name: string;
    hint?: string;
    disabled: boolean;
    scenes: ObsScene[];
    onRefresh: () => void;
    onChange: (next: string[]) => void;
}) {
    const t = useTranslation();
    const [manual, setManual] = useState('');
    const allNames = Array.from(
        new Set([...scenes.map((s) => s.name), ...value].filter((s) => s.trim().length > 0)),
    );

    const toggle = (sceneName: string) => {
        if (disabled) return;
        const exists = value.includes(sceneName);
        onChange(exists ? value.filter((item) => item !== sceneName) : [...value, sceneName]);
    };

    const addManual = () => {
        const trimmed = manual.trim();
        if (!trimmed || disabled) return;
        if (!value.includes(trimmed)) onChange([...value, trimmed]);
        setManual('');
    };

    return (
        <div
            className="mining-scene-picker"
            id={id}
            role="group"
            aria-label={name}
            aria-description={hint}
        >
            <div className="mining-scene-chips">
                {allNames.length === 0 ? (
                    <span className="mining-muted-inline">{t('mining.noScenesDetected')}</span>
                ) : (
                    allNames.map((sceneName) => {
                        const selected = value.includes(sceneName);
                        return (
                            <button
                                key={sceneName}
                                type="button"
                                disabled={disabled}
                                className={'mining-scene-chip' + (selected ? ' is-selected' : '')}
                                aria-pressed={selected}
                                onClick={() => toggle(sceneName)}
                            >
                                {selected && <MiningIcon name="check" size={12} />}
                                <span>{sceneName}</span>
                            </button>
                        );
                    })
                )}
            </div>
            <div className="mining-scene-controls">
                <input
                    type="text"
                    disabled={disabled}
                    placeholder={t('mining.addScenePlaceholder')}
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addManual();
                        }
                    }}
                />
                <button
                    type="button"
                    disabled={disabled || !manual.trim()}
                    onClick={addManual}
                >
                    {t('mining.add')}
                </button>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={onRefresh}
                    title={t('mining.refreshScenes')}
                >
                    <MiningIcon name="refresh" size={13} />
                    <span>{t('mining.refresh')}</span>
                </button>
            </div>
        </div>
    );
}

export function PromptBuilderDialog({
    open,
    nativeLanguageName,
    onInsert,
    onReplace,
    onClose,
}: {
    open: boolean;
    nativeLanguageName: string;
    onInsert: (snippet: string) => void;
    onReplace: (fullTemplate: string) => void;
    onClose: () => void;
}) {
    const t = useTranslation();

    useEffect(() => {
        if (!open) return;
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div
            className="mining-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mining-prompt-builder-title"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="mining-modal">
                <div className="mining-modal-head">
                    <h3 id="mining-prompt-builder-title">{t('mining.promptBuilder.title')}</h3>
                    <button
                        type="button"
                        className="mining-icon-btn"
                        aria-label={t('mining.close')}
                        onClick={onClose}
                    >
                        <MiningIcon name="clear" size={15} />
                    </button>
                </div>
                <div className="mining-modal-body">
                    <div className="mining-modal-group">
                        <h4>{t('mining.promptBuilder.insertPlaceholders')}</h4>
                        <div className="mining-placeholder-list">
                            {PROMPT_PLACEHOLDERS.map((item) => (
                                <div
                                    key={item.token}
                                    className="mining-placeholder-row"
                                >
                                    <button
                                        type="button"
                                        className="mining-token-btn"
                                        onClick={() => onInsert(item.token)}
                                    >
                                        <code>{item.token}</code>
                                    </button>
                                    <span>{t(item.descKey)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="mining-modal-group">
                        <h4>{t('mining.promptBuilder.templates')}</h4>
                        <div className="mining-modal-actions-row">
                            <button
                                type="button"
                                onClick={() => onReplace(FULL_PROMPT_TEMPLATE)}
                            >
                                {t('mining.promptBuilder.loadDefault')}
                            </button>
                            <button
                                type="button"
                                onClick={() => onInsert(buildTranslationPrompt(nativeLanguageName))}
                            >
                                {t('mining.promptBuilder.insertTranslation')}
                            </button>
                            <button
                                type="button"
                                onClick={() => onInsert(buildContextPrompt(nativeLanguageName))}
                            >
                                {t('mining.promptBuilder.insertContext')}
                            </button>
                        </div>
                    </div>
                </div>
                <div className="mining-modal-foot">
                    <button
                        type="button"
                        className="ws-primary"
                        onClick={onClose}
                    >
                        {t('mining.close')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export function ConfirmDangerDialog({
    title,
    message,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
}: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div
            className="mining-modal-backdrop"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="mining-danger-title"
            aria-describedby="mining-danger-desc"
            onClick={(e) => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="mining-modal mining-modal-danger">
                <div className="mining-modal-head">
                    <div className="mining-modal-title-row">
                        <MiningIcon name="alert" size={18} />
                        <h3 id="mining-danger-title">{title}</h3>
                    </div>
                </div>
                <div className="mining-modal-body">
                    <p id="mining-danger-desc">{message}</p>
                </div>
                <div className="mining-modal-foot">
                    <button
                        type="button"
                        autoFocus
                        onClick={onCancel}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        className="danger"
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
