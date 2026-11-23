import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invokeIpc, onIpc } from '../../lib/ipc';
import { useLocale, useTranslation } from '../../i18n';
import type { ObsScene } from '../../types/models';
import {
    categories,
    destinationPage,
    fieldPage,
    keySettings,
    orderFields,
} from './miningSettingsLayout';
import { useFieldLabels } from './miningFieldLabels';
import {
    AI_PROVIDER_GUIDES,
    AUDIO_FFMPEG_PRESETS,
    CONFIRMATION_GAMEPAD_FIELDS,
    DOCS_LINKS,
    GAMEPAD_BUTTON_OPTIONS,
    HOTKEY_GROUPS,
    RECOMMENDED_GEMINI_MODELS,
    RECOMMENDED_GROQ_MODELS,
    RECOMMENDED_ZAI_MODELS,
    SECTION_CARDS,
    buildStudyPrompt,
    detectAudioFfmpegPreset,
    getFieldMeta,
    getObsFpsStatus,
    isAiProviderConfigured,
    isFieldDisabled,
    isFieldVisible,
    renderPromptPreview,
    suggestGsmFieldMappings,
    validateCustomFullPrompt,
    type FieldImportance,
} from './miningSettingsRules';
import {
    ConfirmDangerDialog,
    HotkeyInput,
    MiningIcon,
    PathInput,
    PromptBuilderDialog,
    ScenePickerField,
    SecretInput,
} from './MiningControls';
import '../Workspace.css';
import './MiningSettings.css';

type MiningDestination = { root: string; subtab: string };
type Profile = { name: string; parent: string | null; scenes: string[] };
type Field = {
    path: string;
    value: unknown;
    baseValue?: unknown;
    options: string[];
    range: [number, number] | null;
    pinned: boolean;
    global?: boolean;
};
type Source = { name: string; uri: string; enabled: boolean };
type Snapshot = {
    target: string | null;
    active: string;
    profiles: Profile[];
    fields: Field[];
    sourceDefaults?: Source[];
    ankiFields?: string[];
    animatedLockFps?: number | null;
    migrationBackup: string | null;
    migrationProfile: string | null;
};
type Edit = {
    path: string;
    before: unknown;
    pinned: boolean;
    value?: unknown;
    inherit?: boolean;
    invalid?: boolean;
};
type NewKind = 'createProfile' | 'createScene';
type DangerPromptKind = 'process_pausing' | 'dont_collect_stats';

const DEFAULT_AUTO_ACCEPT_SECONDS = 10;
const AUTOSAVE_DELAY_MS = 400;
const RESTART_PATHS = new Set([
    'advanced.localhost_bind_address',
    'advanced.direct_websocket_port',
    'general.single_port',
]);

function languageName(names: Intl.DisplayNames, code: string) {
    try {
        return names.of(code) || code;
    } catch {
        return code;
    }
}

function ImportanceBadge({ importance }: { importance?: FieldImportance }) {
    const t = useTranslation();
    if (!importance || importance === 'important') return null;
    return (
        <span className={'mining-badge mining-badge--' + importance}>
            {t('mining.importance.' + importance)}
        </span>
    );
}

function FieldInput({
    field,
    value,
    name,
    disabled,
    change,
    sourceDefaults,
    hint,
    choices,
    languageNames,
    onBrowse,
    scenes,
    onRefreshScenes,
    minOverride,
    invalid,
}: {
    field: Field;
    value: unknown;
    name: string;
    disabled: boolean;
    change: (v: unknown, invalid?: boolean) => void;
    sourceDefaults?: Source[];
    hint?: string;
    choices?: string[];
    languageNames: Intl.DisplayNames;
    onBrowse?: (directory: boolean) => void;
    scenes?: ObsScene[];
    onRefreshScenes?: () => void;
    minOverride?: number;
    invalid?: boolean;
}) {
    const t = useTranslation();
    const meta = getFieldMeta(field.path);
    const props = {
        id: 'mining-field-' + field.path,
        disabled,
        'aria-label': name,
        'aria-description': hint,
        'aria-invalid': invalid || undefined,
    };

    if (typeof field.value === 'boolean') {
        return (
            <input
                {...props}
                type="checkbox"
                className="mining-switch"
                checked={Boolean(value)}
                onChange={(e) => change(e.target.checked)}
            />
        );
    }

    if (meta.gamepad) {
        const current = String(value ?? '');
        const hasCurrent = GAMEPAD_BUTTON_OPTIONS.some((opt) => opt.value === current);
        return (
            <select
                {...props}
                value={current}
                onChange={(e) => change(e.target.value)}
            >
                {!hasCurrent && current && <option value={current}>{current}</option>}
                {GAMEPAD_BUTTON_OPTIONS.map((opt) => (
                    <option
                        key={opt.value}
                        value={opt.value}
                    >
                        {opt.value === '' ? t('mining.disabled') : opt.label}
                    </option>
                ))}
            </select>
        );
    }

    if (meta.hotkey) {
        return (
            <HotkeyInput
                id={props.id}
                value={String(value ?? '')}
                name={name}
                hint={hint}
                disabled={disabled}
                onChange={(next) => change(next)}
            />
        );
    }

    if (meta.numericOptions?.length) {
        const currentNum = Number(value);
        const options = meta.numericOptions.includes(currentNum)
            ? meta.numericOptions
            : [currentNum, ...meta.numericOptions];
        return (
            <select
                {...props}
                value={String(currentNum)}
                onChange={(e) => change(Number(e.target.value))}
            >
                {options.map((v) => (
                    <option
                        key={v}
                        value={String(v)}
                    >
                        {v}
                        {meta.unit || ''}
                    </option>
                ))}
            </select>
        );
    }

    const selectOptions = field.options?.length ? field.options : meta.options;
    if (selectOptions?.length) {
        const strVal = String(value ?? '');
        const options = selectOptions.includes(strVal) ? selectOptions : [strVal, ...selectOptions];
        return (
            <select
                {...props}
                value={strVal}
                onChange={(e) => change(e.target.value)}
            >
                {options.map((v) => {
                    const pretty = meta.optionLabels?.[v];
                    return (
                        <option
                            key={v}
                            value={v}
                        >
                            {pretty !== undefined
                                ? pretty
                                : v && /general\.(native|target)_language$/.test(field.path)
                                  ? languageName(languageNames, v)
                                  : v || t('mining.automatic')}
                        </option>
                    );
                })}
            </select>
        );
    }

    if (typeof field.value === 'number') {
        const min = minOverride ?? field.range?.[0] ?? meta.range?.[0];
        const max = field.range?.[1] ?? meta.range?.[1];
        const numVal = value === '' ? '' : Number(value);
        return (
            <div className="mining-number-wrap">
                <input
                    {...props}
                    type="number"
                    step={meta.step ?? 'any'}
                    min={min}
                    max={max}
                    value={String(value)}
                    onChange={(e) =>
                        change(
                            e.target.value === '' ? '' : Number(e.target.value),
                            !e.target.validity.valid || e.target.value === '',
                        )
                    }
                />
                {meta.unit && <span className="mining-unit">{meta.unit}</span>}
                {meta.zeroLabelKey && numVal === 0 && (
                    <span className="mining-zero-hint">{t(meta.zeroLabelKey)}</span>
                )}
            </div>
        );
    }

    if (field.path === 'general.websocket_sources') {
        const sources = (Array.isArray(value) ? value : []) as Source[];
        const updateSources = (next: Source[]) =>
            change(next, next.some((source) => !source.uri.trim()));
        return (
            <div
                className="mining-sources"
                role="group"
                aria-label={name}
                id={props.id}
            >
                <div
                    className="mining-source-head"
                    aria-hidden="true"
                >
                    <span>{t('mining.on')}</span>
                    <span>{t('mining.name')}</span>
                    <span>{t('mining.uri')}</span>
                    <span />
                </div>
                {sources.map((s, i) => (
                    <div
                        className="mining-source-row"
                        key={i}
                    >
                        <input
                            type="checkbox"
                            disabled={disabled}
                            aria-label={t('mining.enabled')}
                            checked={s.enabled}
                            onChange={(e) =>
                                updateSources(
                                    sources.map((row, j) =>
                                        i === j ? { ...row, enabled: e.target.checked } : row,
                                    ),
                                )
                            }
                        />
                        {(['name', 'uri'] as const).map((k) => (
                            <input
                                key={k}
                                disabled={disabled}
                                aria-label={t('mining.' + k)}
                                aria-invalid={k === 'uri' && !s.uri.trim() ? true : undefined}
                                placeholder={t('mining.' + k)}
                                value={s[k]}
                                onChange={(e) =>
                                    updateSources(
                                        sources.map((row, j) =>
                                            i === j ? { ...row, [k]: e.target.value } : row,
                                        ),
                                    )
                                }
                            />
                        ))}
                        <button
                            type="button"
                            className="mining-icon-btn"
                            disabled={disabled}
                            aria-label={t('mining.remove') + ' ' + s.name}
                            title={t('mining.remove')}
                            onClick={() => updateSources(sources.filter((_, j) => j !== i))}
                        >
                            <MiningIcon name="clear" size={15} />
                        </button>
                    </div>
                ))}
                <div className="mining-source-footer">
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                            updateSources([...sources, { name: '', uri: 'localhost:', enabled: true }])
                        }
                    >
                        <MiningIcon name="plus" size={15} />
                        {t('mining.addSource')}
                    </button>
                    {sourceDefaults && (
                        <button
                            type="button"
                            disabled={disabled}
                            onClick={() => updateSources(sourceDefaults)}
                        >
                            {t('mining.resetSources')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (
        (field.path === 'discord.blacklisted_scenes' || field.path === 'profiles.scenes') &&
        onRefreshScenes
    ) {
        return (
            <ScenePickerField
                id={props.id}
                value={Array.isArray(value) ? (value as string[]) : []}
                name={name}
                hint={hint}
                disabled={disabled}
                scenes={scenes ?? []}
                onRefresh={onRefreshScenes}
                onChange={(next) => change(next)}
            />
        );
    }

    if (Array.isArray(field.value)) {
        return (
            <textarea
                {...props}
                rows={3}
                value={Array.isArray(value) ? value.join('\n') : String(value)}
                placeholder={t('mining.onePerLine')}
                onChange={(e) =>
                    change(
                        e.target.value
                            ? e.target.value
                                  .split('\n')
                                  .map((line) =>
                                      field.path === 'anki.tags_to_check'
                                          ? line.toLowerCase()
                                          : line,
                                  )
                            : [],
                    )
                }
            />
        );
    }

    if (/prompt|ffmpeg_reencode_options/.test(field.path)) {
        return (
            <textarea
                {...props}
                rows={field.path === 'ai.custom_full_prompt' ? 6 : 3}
                value={String(value ?? '')}
                onChange={(e) => {
                    const next = e.target.value;
                    const invalid =
                        field.path === 'ai.custom_full_prompt' && !validateCustomFullPrompt(next);
                    change(next, invalid);
                }}
            />
        );
    }

    if (meta.secret) {
        return (
            <SecretInput
                id={props.id}
                value={String(value ?? '')}
                name={name}
                hint={hint}
                placeholder={meta.placeholder}
                disabled={disabled}
                onChange={(next) => change(next)}
            />
        );
    }

    if (meta.browse && onBrowse) {
        return (
            <PathInput
                id={props.id}
                value={String(value ?? '')}
                name={name}
                hint={hint}
                disabled={disabled}
                directory={meta.browse === 'directory'}
                onBrowse={() => onBrowse(meta.browse === 'directory')}
                onChange={(next) => change(next)}
            />
        );
    }

    return (
        <>
            <input
                {...props}
                list={choices?.length ? props.id + '-choices' : undefined}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={meta.placeholder}
                value={String(value ?? '')}
                onChange={(e) => change(e.target.value)}
            />
            {!!choices?.length && (
                <datalist id={props.id + '-choices'}>
                    {choices.map((choice) => (
                        <option
                            key={choice}
                            value={choice}
                        />
                    ))}
                </datalist>
            )}
        </>
    );
}

export function MiningSettings({ obsOnly = false }: { obsOnly?: boolean }) {
    const view = obsOnly ? 'obs' : 'mining';
    const t = useTranslation();
    const label = useFieldLabels(true);
    const [locale] = useLocale();
    const languages = useMemo(
        () => new Intl.DisplayNames([locale === 'ukr' ? 'uk' : locale], { type: 'language' }),
        [locale],
    );
    const [destination, setDestination] = useState<MiningDestination>();
    const [manage, setManage] = useState(false);
    const [closeRequested, setCloseRequested] = useState(false);
    const content = useRef<HTMLElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const title = t('mining.windowTitle');
    const [data, setData] = useState<Snapshot | null>(null);
    const [target, setTarget] = useState<string | null | undefined>(undefined);
    const [group, setGroup] = useState(obsOnly ? 'obs' : 'key_settings');
    const [subtabs, setSubtabs] = useState<Record<string, string>>({});
    const [search, setSearch] = useState('');
    const [draft, setDraft] = useState<Record<string, Edit>>({});
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [error, setError] = useState('');
    const [newKind, setNewKind] = useState<NewKind | null>(null);
    const [newName, setNewName] = useState('');
    const [base, setBase] = useState('');
    const [follow, setFollow] = useState(true);
    const [deleting, setDeleting] = useState(false);
    const [scenes, setScenes] = useState<ObsScene[]>([]);
    const [ankiRefreshNonce, setAnkiRefreshNonce] = useState(0);
    const [dismissedMappingModel, setDismissedMappingModel] = useState<string | null>(null);
    const [userChangedNoteType, setUserChangedNoteType] = useState(false);
    const [promptBuilderOpen, setPromptBuilderOpen] = useState(false);
    const [sampleSentence, setSampleSentence] = useState('昨日は忙しかったけど、今日は少し休めそうだ。');
    const [promptPreview, setPromptPreview] = useState('');
    const [dangerPrompt, setDangerPrompt] = useState<DangerPromptKind | null>(null);
    const [copiedWs, setCopiedWs] = useState(false);
    const serial = useRef(0);
    const saveInFlight = useRef(false);
    const refreshAfterSave = useRef(false);
    const currentTarget = useRef<string | null | undefined>(undefined);
    const revision = useRef<MiningDestination | undefined>(undefined);
    const edits = Object.values(draft);
    const pending = edits.length;
    const hasInvalid = edits.some((edit) => edit.invalid);
    const canSave = edits.some((edit) => !edit.invalid);
    const editTarget = data?.target;

    const load = useCallback(
        async (which: string | null | undefined) => {
            const ticket = ++serial.current;
            try {
                const next = await invokeIpc<Snapshot>('settings.mining.read', {
                    view,
                    ...(which === undefined ? {} : { target: which }),
                });
                if (ticket === serial.current) {
                    setData(next);
                    currentTarget.current = next.target;
                    setError('');
                }
            } catch (e) {
                if (ticket === serial.current) setError(String(e));
            }
        },
        [view],
    );

    const refreshObsScenes = useCallback(() => {
        void invokeIpc<ObsScene[]>('obs.getScenes')
            .then((items) => {
                if (Array.isArray(items)) setScenes(items);
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        void load(currentTarget.current);
        return onIpc('settings.mining.changed', () => {
            if (saveInFlight.current) refreshAfterSave.current = true;
            else void load(currentTarget.current);
        });
    }, [load]);

    useEffect(() => {
        if (obsOnly) return;
        return onIpc('settings.mining.requestClose', () => setCloseRequested(true));
    }, [obsOnly]);

    useEffect(() => {
        if (obsOnly) return;
        let mounted = true;
        const receive = (nextDest: MiningDestination | null) => {
            if (mounted && nextDest && typeof nextDest.root === 'string') setDestination(nextDest);
        };
        const onError = (err: unknown) => {
            if (mounted) setError(String(err));
        };
        const off = onIpc('settings.mining.navigate', () => {
            void invokeIpc<MiningDestination | null>('settings.mining.navigation')
                .then(receive)
                .catch(onError);
        });
        document.title = title;
        void invokeIpc<MiningDestination | null>('settings.mining.ready', { title })
            .then(receive)
            .catch(onError);
        return () => {
            mounted = false;
            off();
        };
    }, [title, obsOnly]);

    useEffect(() => {
        if (closeRequested && !pending && !busy && !saving) {
            void invokeIpc('settings.mining.close').catch((e) => {
                setCloseRequested(false);
                setError(String(e));
            });
        }
    }, [closeRequested, pending, busy, saving]);

    useEffect(() => {
        if (!destination || revision.current === destination || pending || busy || closeRequested)
            return;
        revision.current = destination;
        setManage(destination.root === 'profiles');
        setDeleting(false);
        setNewKind(null);
        const [category, nextTab] = destinationPage(destination.root, destination.subtab);
        setGroup(category);
        setSubtabs((old) => ({ ...old, [category]: nextTab }));
        setSearch('');
        if (currentTarget.current === null) {
            setTarget(undefined);
            void load(undefined);
        }
    }, [destination, load, pending, busy, closeRequested]);

    useEffect(() => {
        if (content.current) content.current.scrollTop = 0;
    }, [group, subtabs, search, manage, data?.target]);

    const mutate = useCallback(
        async (request: object) => {
            if (pending || busy) return;
            setBusy(true);
            setError('');
            try {
                const next = await invokeIpc<Snapshot>('settings.mining.apply', {
                    ...request,
                    view,
                });
                ++serial.current;
                currentTarget.current = next.target;
                setData(next);
                setTarget(next.target);
                setManage(false);
                setNewKind(null);
                setDeleting(false);
                setDraft({});
                setUserChangedNoteType(false);
            } catch (e) {
                setError(String(e));
            } finally {
                setBusy(false);
            }
        },
        [busy, pending, view],
    );

    const saveDraft = useCallback(async () => {
        if (editTarget === undefined || busy || saveInFlight.current) return;
        const changes = Object.values(draft).filter((edit) => !edit.invalid);
        if (!changes.length) return;

        saveInFlight.current = true;
        setSaving(true);
        setSaveError('');
        try {
            const next = await invokeIpc<Snapshot>('settings.mining.apply', {
                op: 'edit',
                target: editTarget,
                changes,
                view,
            });
            ++serial.current;
            setData(next);
            const savedFields = new Map(next.fields.map((field) => [field.path, field]));
            setDraft((current) => {
                const outstanding = { ...current };
                for (const sent of changes) {
                    const latest = outstanding[sent.path];
                    if (latest === sent) {
                        delete outstanding[sent.path];
                    } else if (latest) {
                        // A newer edit to this field must compare against the value we just saved.
                        const saved = savedFields.get(sent.path);
                        if (saved) {
                            outstanding[sent.path] = {
                                ...latest,
                                before: saved.value,
                                pinned: saved.pinned,
                            };
                        }
                    }
                }
                return outstanding;
            });
        } catch (e) {
            setSaveError(String(e) || t('mining.autoSaveFailed'));
        } finally {
            saveInFlight.current = false;
            setSaving(false);
            if (refreshAfterSave.current) {
                refreshAfterSave.current = false;
                void load(currentTarget.current);
            }
        }
    }, [busy, draft, editTarget, load, t, view]);

    useEffect(() => {
        if (!canSave || busy || saving || saveError) return;
        const timer = window.setTimeout(saveDraft, closeRequested ? 0 : AUTOSAVE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [busy, canSave, closeRequested, saveDraft, saveError, saving]);

    // Ctrl+F focuses search, and Ctrl+S flushes edits immediately.
    useEffect(() => {
        if (obsOnly) return;
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void saveDraft();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [obsOnly, saveDraft]);

    const activeSubtab = subtabs[group] || '';
    useEffect(() => {
        if (newKind || manage || (group === 'general' && activeSubtab === 'discord')) {
            refreshObsScenes();
        }
    }, [newKind, manage, group, activeSubtab, refreshObsScenes]);

    const showModels =
        !obsOnly &&
        !manage &&
        (group === 'key_settings' || group === 'anki' || group === 'ai' || !!search.trim());
    const model = draft['anki.note_type']?.inherit
        ? data?.fields.find((f) => f.path === 'anki.note_type')?.baseValue
        : (draft['anki.note_type']?.value ??
          data?.fields.find((f) => f.path === 'anki.note_type')?.value);
    const ankiUrl = data?.fields.find((f) => f.path === 'anki.url')?.value;
    const [noteTypes, setNoteTypes] = useState<string[]>([]);
    const [ankiFields, setAnkiFields] = useState<string[]>([]);

    useEffect(() => {
        let live = true;
        setNoteTypes([]);
        if (showModels && ankiUrl)
            void invokeIpc<string[]>('settings.mining.ankiChoices', {})
                .then((items) => {
                    if (live && Array.isArray(items)) setNoteTypes(items);
                })
                .catch(() => {});
        return () => {
            live = false;
        };
    }, [showModels, ankiUrl, ankiRefreshNonce]);

    useEffect(() => {
        let live = true;
        setAnkiFields([]);
        if (!showModels || !ankiUrl || !model) return;
        const timer = window.setTimeout(() => {
            void invokeIpc<string[]>('settings.mining.ankiChoices', { model })
                .then((items) => {
                    if (live && Array.isArray(items)) setAnkiFields(items);
                })
                .catch(() => {});
        }, 250);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [showModels, ankiUrl, model, ankiRefreshNonce]);

    // Build effective values map (saved + draft) for all Qt rule evaluations
    const effectiveValues = useMemo(() => {
        const map: Record<string, unknown> = {};
        if (!data) return map;
        for (const f of data.fields) {
            const edit = draft[f.path];
            map[f.path] = edit ? (edit.inherit ? f.baseValue : edit.value) : f.value;
        }
        return map;
    }, [data, draft]);

    const openExternal = useCallback((url: string) => {
        void invokeIpc('open-external-link', url).catch((e) => setError(String(e)));
    }, []);

    if (!data) {
        return (
            <div
                className="mining-loading-shell"
                role="status"
            >
                <div className="mining-loading-card">
                    <span>{error || t('mining.loading')}</span>
                    {error && (
                        <button
                            type="button"
                            className="ws-primary"
                            onClick={() => void load(target)}
                        >
                            {t('mining.retry')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    const profile = data.profiles.find((p) => p.name === data.target);
    const bases = data.profiles.filter((p) => !p.parent);
    const games = data.profiles.filter((p) => p.parent);
    const byPath = new Map(data.fields.map((f) => [f.path, f]));
    const keyRows = keySettings.flatMap((path) => (byPath.has(path) ? [byPath.get(path)!] : []));
    const available = data.fields.filter((f) => {
        const [category] = fieldPage(f.path);
        return obsOnly ? category === 'obs' : category in categories && category !== 'obs';
    });

    const groups = Object.keys(categories).filter((g) =>
        g === 'key_settings'
            ? !obsOnly && keyRows.length > 0
            : available.some((f) => fieldPage(f.path)[0] === g),
    );
    const section = groups.includes(group) ? group : groups[0];
    const sectionRows = available.filter((f) => fieldPage(f.path)[0] === section);

    const providerOptions = byPath.get('ai.provider')?.options ?? [];
    const gsmCloudEnabled =
        providerOptions.includes('GSM Cloud') || subtabs.ai === 'gsm_cloud';

    const tabs = (categories[section] || []).filter((tabKey) => {
        if (section === 'ai' && tabKey === 'gsm_cloud' && !gsmCloudEnabled) return false;
        return sectionRows.some((f) => fieldPage(f.path)[1] === tabKey);
    });
    const tab = tabs.includes(subtabs[section]) ? subtabs[section] : tabs[0];
    const query = search.trim().toLocaleLowerCase();

    // Confirmation master state (Qt: show_update_confirmation_dialog_v2 || review_after_session.enabled)
    const afterSession = Boolean(effectiveValues['features.review_after_session.enabled']);
    const confirmationEnabled =
        Boolean(effectiveValues['anki.show_update_confirmation_dialog_v2']) || afterSession;

    const visibilityContext = {
        isSearch: Boolean(query),
        isGlobalScope: data.target === null,
        confirmationEnabled,
        afterSession,
    };

    const rawRows = manage
        ? data.fields.filter((f) => fieldPage(f.path)[0] === 'profiles')
        : query
          ? available.filter((f) =>
                [
                    f.path,
                    label(f.path).name,
                    label(f.path).help ?? '',
                    ...fieldPage(f.path).map((k) => t('mining.sections.' + k)),
                ]
                    .join(' ')
                    .toLocaleLowerCase()
                    .includes(query),
            )
          : section === 'key_settings'
            ? keyRows
            : orderFields(
                  sectionRows.filter((f) => fieldPage(f.path)[1] === tab),
                  section,
                  tab,
              );

    const groupMappings = !manage && !query && section === 'anki' && tab === 'general';
    const visibleRows = rawRows.filter((f) => {
        if (
            groupMappings &&
            /^anki\.[^.]+\.(enabled|overwrite|append)$/.test(f.path) &&
            byPath.has(f.path.slice(0, f.path.lastIndexOf('.')) + '.name')
        ) {
            return false;
        }
        return isFieldVisible(f.path, effectiveValues, visibilityContext);
    });

    const choose = (next: string | null) => {
        ++serial.current;
        currentTarget.current = next;
        setTarget(next);
        setData((old) => (old?.target === next ? old : null));
        setNewKind(null);
        setDeleting(false);
        setSearch('');
        setError('');
        setUserChangedNoteType(false);
        setDismissedMappingModel(null);
        void load(next);
    };

    const startNew = (kind: NewKind) => {
        setBase(profile?.parent || profile?.name || bases[0]?.name || '');
        setNewName('');
        setFollow(true);
        setDeleting(false);
        setNewKind(kind);
    };

    const change = (f: Field, v: unknown, invalid = false, inherit = false) => {
        // Qt safety confirmation gates for enabling dangerous settings
        if (!inherit && f.path === 'process_pausing.enabled' && v === true && !effectiveValues[f.path]) {
            setDangerPrompt('process_pausing');
            return;
        }
        if (!inherit && f.path === 'advanced.dont_collect_stats' && v === true && !effectiveValues[f.path]) {
            setDangerPrompt('dont_collect_stats');
            return;
        }
        if (f.path === 'anki.note_type') {
            setUserChangedNoteType(true);
            setDismissedMappingModel(null);
        }
        applyFieldChange(f, v, invalid, inherit);
    };

    const applyFieldChange = (f: Field, v: unknown, invalid = false, inherit = false) => {
        setDraft((old) => {
            const next = { ...old };
            const record = (
                field: Field,
                value: unknown,
                useBase: boolean,
                invalidInput = false,
            ) => {
                next[field.path] = {
                    path: field.path,
                    before: old[field.path] ? old[field.path].before : field.value,
                    pinned: old[field.path]?.pinned ?? field.pinned,
                    value,
                    inherit: useBase,
                    invalid: invalidInput,
                };
            };
            record(f, v, inherit, invalid);

            // Qt rule: Anki overwrite and append are mutually exclusive.
            const mode = /^(anki\.[^.]+\.)(overwrite|append)$/.exec(f.path);
            if (mode && (inherit || v === true)) {
                const opposite = mode[1] + (mode[2] === 'append' ? 'overwrite' : 'append');
                const paired = byPath.get(opposite);
                if (paired) record(paired, false, inherit);
            }

            // Qt rule: saving Custom audio ffmpeg options mirrors to custom_encode_settings
            if (!inherit && f.path === 'audio.ffmpeg_reencode_options') {
                const presetId = detectAudioFfmpegPreset(String(v ?? ''));
                const customField = byPath.get('audio.custom_encode_settings');
                if (presetId === 'custom' && customField) {
                    record(customField, String(v ?? ''), false);
                }
            }

            return next;
        });
    };

    const locked = busy || pending > 0;

    // Categories with unsaved draft edits for subtle sidebar dot
    const dirtyCategories = new Set(Object.keys(draft).map((p) => fieldPage(p)[0]));

    // Field suggestions (AnkiConnect + recommended AI models)
    const getChoicesForField = (path: string): string[] | undefined => {
        if (path === 'anki.note_type') return noteTypes;
        if (/^anki\.[^.]+\.name$/.test(path) || path === 'ai.anki_field') {
            if (ankiFields.length) return ankiFields;
            if (model === byPath.get('anki.note_type')?.value) return data.ankiFields;
            return undefined;
        }
        if (path === 'ai.gemini_model' || path === 'ai.gemini_backup_model') {
            return [...RECOMMENDED_GEMINI_MODELS];
        }
        if (path === 'ai.groq_model' || path === 'ai.groq_backup_model') {
            return [...RECOMMENDED_GROQ_MODELS];
        }
        if (path === 'ai.zai_model' || path === 'ai.zai_backup_model') {
            return [...RECOMMENDED_ZAI_MODELS];
        }
        return undefined;
    };

    // Anki note-type auto-suggestion banner (ported from anki_setup.py)
    const suggestedMappings = (() => {
        const currentModel = String(model ?? '').trim();
        if (
            !userChangedNoteType ||
            !currentModel ||
            dismissedMappingModel === currentModel ||
            !ankiFields.length
        ) {
            return [];
        }
        const rawSuggestions = suggestGsmFieldMappings(ankiFields);
        return Object.entries(rawSuggestions)
            .filter(([path, suggested]) => {
                const field = byPath.get(path);
                return field && String(effectiveValues[path] ?? '') !== suggested;
            })
            .map(([path, suggested]) => ({
                path,
                current: String(effectiveValues[path] ?? ''),
                suggested,
            }));
    })();

    const applySuggestedMappings = () => {
        for (const item of suggestedMappings) {
            const field = byPath.get(item.path);
            if (field) applyFieldChange(field, item.suggested);
        }
        setDismissedMappingModel(String(model ?? ''));
    };

    const browseForField = async (f: Field, directory: boolean) => {
        try {
            const picked = await invokeIpc<string | null>('settings.mining.pickPath', {
                view,
                directory,
                currentPath: String(effectiveValues[f.path] ?? ''),
                title: label(f.path).name,
            });
            if (typeof picked === 'string' && picked && currentTarget.current === data.target) {
                change(f, picked);
            }
        } catch (e) {
            setError(String(e));
        }
    };

    const inheritanceControl = (f: Field, compact = false) => {
        if (!profile?.parent || f.global) return null;
        const edit = draft[f.path];
        const pinned = edit ? !edit.inherit : f.pinned;
        const source = t(pinned ? 'mining.overridden' : 'mining.inherited', {
            base: profile.parent,
        });
        const action = t(pinned ? 'mining.inherit' : 'mining.pin');
        return (
            <button
                type="button"
                className={'mining-link' + (pinned ? ' is-pinned' : '')}
                disabled={busy}
                aria-label={action + ' · ' + label(f.path).name}
                data-tip={source + ' · ' + action}
                onClick={() =>
                    change(f, edit?.inherit ? f.baseValue : (edit?.value ?? f.value), false, pinned)
                }
            >
                {compact ? (pinned ? '●' : '↳') : source}
            </button>
        );
    };

    // Render a single setting row with all Qt metadata, badges, tooltips, and specialized helpers
    const renderFieldRow = (f: Field, opts?: { compact?: boolean; dashboard?: boolean }) => {
        const edit = draft[f.path];
        const meta = getFieldMeta(f.path);
        const { name, help } = label(f.path);
        const restart = RESTART_PATHS.has(f.path);
        const hint = [help, restart && t('mining.restart')].filter(Boolean).join(' ');
        const value = effectiveValues[f.path];
        const ruleDisabled = isFieldDisabled(f.path, effectiveValues);
        const isDisabled = busy || !!edit?.inherit || ruleDisabled;

        const isPort = f.path === 'general.single_port';
        const isAutoAccept = f.path === 'anki.auto_accept_timer';
        const isAnkiNoteType = f.path === 'anki.note_type';
        const isCustomFullPrompt = f.path === 'ai.custom_full_prompt';
        const isObsFps = f.path === 'obs.recording_fps';
        const portVal = isPort ? String(value ?? 7275) : '';
        const endpointsTip = isPort
            ? [
                  `HTTP: http://127.0.0.1:${portVal}/, /texthooker, /stats, /tools`,
                  `WS: ws://127.0.0.1:${portVal}/ws/texthooker, /ws/overlay, /ws/plaintext`,
              ].join('\n')
            : undefined;

        const autoAcceptNum = Number(value ?? 0);
        const autoAcceptOn = Number.isFinite(autoAcceptNum) && autoAcceptNum > 0;

        const obsFpsStatus = isObsFps
            ? getObsFpsStatus(Number(value ?? 15), data.animatedLockFps)
            : null;

        const fullPromptValid = isCustomFullPrompt
            ? validateCustomFullPrompt(String(value ?? ''))
            : true;

        return (
            <div
                className={
                    'mining-row' +
                    (opts?.compact ? ' mining-row--compact' : '') +
                    (ruleDisabled ? ' is-rule-disabled' : '') +
                    (edit ? ' is-modified' : '')
                }
                key={f.path}
            >
                <div
                    className="mining-label"
                    data-tip={hint || undefined}
                >
                    <label
                        htmlFor={'mining-field-' + f.path}
                        className={
                            (meta.importance && !opts?.dashboard
                                ? 'mining-label--' + meta.importance
                                : '') +
                            (meta.bold ? ' is-bold' : '')
                        }
                    >
                        {name}
                    </label>
                    {!opts?.dashboard && <ImportanceBadge importance={meta.importance} />}
                    {f.global && data.target !== null && (
                        <span
                            className="mining-global"
                            data-tip={t('mining.globalHint')}
                        >
                            {t('mining.global')}
                        </span>
                    )}
                    {f.path === 'process_pausing.require_game_exe_match' && (
                        <span
                            className="mining-lock-pill"
                            data-tip={t('mining.lockedSafetyHint')}
                        >
                            <MiningIcon name="lock" size={11} />
                            {t('mining.locked')}
                        </span>
                    )}
                </div>
                <div className="mining-control">
                    {isAutoAccept ? (
                        <div className="mining-auto-accept">
                            <input
                                type="checkbox"
                                className="mining-switch"
                                disabled={busy || !!edit?.inherit}
                                aria-label={t('mining.enableAutoAccept')}
                                checked={autoAcceptOn}
                                onChange={(e) => {
                                    if (e.target.checked) {
                                        change(
                                            f,
                                            autoAcceptNum > 0
                                                ? autoAcceptNum
                                                : DEFAULT_AUTO_ACCEPT_SECONDS,
                                        );
                                    } else {
                                        change(f, 0);
                                    }
                                }}
                            />
                            <div className="mining-number-wrap">
                                <input
                                    id={'mining-field-' + f.path}
                                    type="number"
                                    min={0}
                                    max={3600}
                                    step={1}
                                    disabled={busy || !!edit?.inherit || !autoAcceptOn}
                                    aria-label={name}
                                    aria-description={hint}
                                    value={autoAcceptOn ? String(autoAcceptNum) : '0'}
                                    onChange={(e) => {
                                        const raw = e.target.value;
                                        const parsed = raw === '' ? '' : Number(raw);
                                        change(
                                            f,
                                            parsed,
                                            raw === '' || !e.target.validity.valid,
                                        );
                                    }}
                                />
                                <span className="mining-unit">s</span>
                            </div>
                        </div>
                    ) : (
                        <FieldInput
                            field={f}
                            value={value}
                            name={name}
                            hint={hint}
                            disabled={isDisabled}
                            invalid={edit?.invalid}
                            change={(v, invalid) => change(f, v, invalid)}
                            sourceDefaults={data.sourceDefaults}
                            languageNames={languages}
                            choices={getChoicesForField(f.path)}
                            onBrowse={meta.browse ? (dir) => void browseForField(f, dir) : undefined}
                            scenes={scenes}
                            onRefreshScenes={refreshObsScenes}
                            minOverride={
                                isObsFps && data.animatedLockFps && data.animatedLockFps > 1
                                    ? data.animatedLockFps
                                    : undefined
                            }
                        />
                    )}

                    {isAnkiNoteType && (
                        <button
                            type="button"
                            className="mining-inline-btn"
                            disabled={busy}
                            title={t('mining.refreshAnkiFields')}
                            onClick={() => setAnkiRefreshNonce((n) => n + 1)}
                        >
                            <MiningIcon name="refresh" size={13} />
                            <span>{t('mining.refreshFields')}</span>
                        </button>
                    )}

                    {isPort && (
                        <span
                            className="mining-help-pill"
                            data-tip={endpointsTip}
                            aria-label={t('mining.endpoints')}
                            tabIndex={0}
                        >
                            <MiningIcon name="info" size={15} />
                        </span>
                    )}

                    {inheritanceControl(f, opts?.dashboard)}
                </div>

                {isPort && (
                    <div className="mining-row-extra mining-port-actions">
                        {(['feed', 'stats', 'copyWs'] as const).map((action) => (
                            <button
                                type="button"
                                key={action}
                                disabled={!!edit?.invalid}
                                onClick={() => {
                                    if (action === 'copyWs') {
                                        window.clipboard?.writeText?.(
                                            'ws://127.0.0.1:' + value + '/ws/texthooker',
                                        );
                                        setCopiedWs(true);
                                        window.setTimeout(() => setCopiedWs(false), 1600);
                                    } else {
                                        openExternal(
                                            'http://127.0.0.1:' +
                                                value +
                                                (action === 'feed' ? '/' : '/stats'),
                                        );
                                    }
                                }}
                            >
                                {action === 'copyWs' && copiedWs
                                    ? t('mining.copied')
                                    : t('mining.' + action)}
                            </button>
                        ))}
                    </div>
                )}

                {isCustomFullPrompt && (
                    <div className="mining-row-extra">
                        <div className="mining-prompt-helper-bar">
                            <span className="mining-muted-inline">
                                {t('mining.promptFullKeysHint')}
                            </span>
                            <button
                                type="button"
                                className="mining-inline-btn"
                                disabled={isDisabled}
                                onClick={() => setPromptBuilderOpen(true)}
                            >
                                <MiningIcon name="sparkles" size={13} />
                                <span>{t('mining.promptBuilder.open')}</span>
                            </button>
                        </div>
                        {!fullPromptValid && (
                            <p
                                role="alert"
                                className="mining-inline-banner mining-inline-banner--danger"
                            >
                                {t('mining.promptMissingSentence')}
                            </p>
                        )}
                    </div>
                )}

                {isObsFps && obsFpsStatus && (
                    <div className="mining-row-extra">
                        <p
                            className={
                                'mining-inline-banner mining-inline-banner--' + obsFpsStatus.tone
                            }
                        >
                            {t(obsFpsStatus.key, obsFpsStatus.vars)}
                        </p>
                    </div>
                )}

                {f.path === 'obs.disable_recording' && (
                    <div className="mining-row-extra">
                        <p className="mining-inline-banner mining-inline-banner--danger">
                            {t('mining.obsDisableRecordingWarning')}
                        </p>
                    </div>
                )}

                {f.path === 'advanced.dont_collect_stats' && (
                    <div className="mining-row-extra">
                        <p className="mining-inline-banner mining-inline-banner--danger">
                            {t('mining.dontCollectStatsWarning')}
                        </p>
                    </div>
                )}

                {!opts?.dashboard &&
                    groupMappings &&
                    /^anki\.[^.]+\.name$/.test(f.path) &&
                    f.path !== 'anki.word.name' && (
                        <div className="mining-row-extra mining-mapping-flags">
                            {renderAnkiFieldFlags(f.path)}
                        </div>
                    )}
            </div>
        );
    };

    const renderAnkiFieldFlags = (namePath: string) => {
        const prefix = namePath.slice(0, -4); // "anki.sentence."
        const fieldKey = namePath.split('.')[1];
        const isCoreSentence = fieldKey === 'sentence';
        const isSyncedAudio = fieldKey === 'sentence_audio';
        const isSyncedPicture = fieldKey === 'picture';
        const syncedField = isSyncedAudio
            ? byPath.get('audio.enabled')
            : isSyncedPicture
              ? byPath.get('screenshot.enabled')
              : undefined;

        const enabledFlag = byPath.get(prefix + 'enabled');
        const overwriteFlag = byPath.get(prefix + 'overwrite');
        const appendFlag = byPath.get(prefix + 'append');

        return (
            <>
                {isCoreSentence ? (
                    <label
                        className="mining-flag is-locked"
                        data-tip={t('mining.coreFieldLocked')}
                    >
                        <input
                            type="checkbox"
                            checked
                            disabled
                            readOnly
                        />
                        <span>{t('mining.terms.enabled')}</span>
                    </label>
                ) : syncedField ? (
                    <div className="mining-flag">
                        <label
                            data-tip={t(
                                isSyncedAudio
                                    ? 'mining.syncedWithAudio'
                                    : 'mining.syncedWithScreenshot',
                            )}
                        >
                            <input
                                type="checkbox"
                                disabled={busy || !!draft[syncedField.path]?.inherit}
                                checked={Boolean(effectiveValues[syncedField.path])}
                                onChange={(e) => change(syncedField, e.target.checked)}
                            />
                            <span>{t('mining.terms.enabled')}</span>
                        </label>
                    </div>
                ) : enabledFlag ? (
                    <div className="mining-flag">
                        <label>
                            <input
                                id={'mining-field-' + enabledFlag.path}
                                type="checkbox"
                                disabled={busy || !!draft[enabledFlag.path]?.inherit}
                                checked={Boolean(effectiveValues[enabledFlag.path])}
                                onChange={(e) => change(enabledFlag, e.target.checked)}
                            />
                            <span>{t('mining.terms.enabled')}</span>
                        </label>
                        {inheritanceControl(enabledFlag, true)}
                    </div>
                ) : null}

                {[overwriteFlag, appendFlag].map((flag) => {
                    if (!flag) return null;
                    const mode = flag.path.endsWith('.overwrite') ? 'overwrite' : 'append';
                    const flagDisabled =
                        busy ||
                        !!draft[flag.path]?.inherit ||
                        isFieldDisabled(flag.path, effectiveValues);
                    return (
                        <div
                            key={flag.path}
                            className={'mining-flag' + (flagDisabled ? ' is-disabled' : '')}
                        >
                            <label>
                                <input
                                    id={'mining-field-' + flag.path}
                                    type="checkbox"
                                    disabled={flagDisabled}
                                    checked={Boolean(effectiveValues[flag.path])}
                                    onChange={(e) => change(flag, e.target.checked)}
                                />
                                <span>{t('mining.terms.' + mode)}</span>
                            </label>
                            {inheritanceControl(flag, true)}
                        </div>
                    );
                })}
            </>
        );
    };

    // --- Specialized Section Renderers ---

    const renderKeySettingsDashboard = () => {
        const pick = (paths: string[]) =>
            paths.flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));
        const renderKeyField = (field: Field) =>
            renderFieldRow(field, { compact: true, dashboard: true });
        const langFields = pick(['general.native_language', 'general.target_language']);
        const inputToggles = pick(['general.use_websocket', 'general.use_clipboard']);
        const portField = byPath.get('general.single_port');
        const wsSourcesField = byPath.get('general.websocket_sources');
        const ankiNoteField = byPath.get('anki.note_type');
        const ankiCoreFields = pick([
            'anki.word.name',
            'anki.sentence.name',
            'anki.sentence_audio.name',
            'anki.picture.name',
        ]);
        const audioOffsets = pick(['audio.beginning_offset', 'audio.end_offset']);
        const ankiActionToggles = pick([
            'features.open_anki_edit',
            'features.open_anki_in_browser',
        ]);

        return (
            <div className="mining-key-dashboard">
                <section className="mining-card mining-card--compact">
                    <div className="mining-card-head">
                        <h3>{t('mining.cards.languagesInput')}</h3>
                    </div>
                    <div className="mining-card-body">
                        {!!langFields.length && (
                            <div className="mining-two-col">{langFields.map(renderKeyField)}</div>
                        )}
                        {!!inputToggles.length && (
                            <div className="mining-two-col mining-key-toggles">
                                {inputToggles.map(renderKeyField)}
                            </div>
                        )}
                        {portField && renderKeyField(portField)}
                    </div>
                </section>

                {wsSourcesField && (
                    <section className="mining-card mining-card--compact">
                        <div className="mining-card-head">
                            <h3>{t('mining.cards.websocketSources')}</h3>
                        </div>
                        <div className="mining-card-body">{renderKeyField(wsSourcesField)}</div>
                    </section>
                )}

                {(ankiNoteField || ankiCoreFields.length > 0) && (
                    <section className="mining-card mining-card--compact">
                        <div className="mining-card-head">
                            <h3>{t('mining.cards.ankiCoreMapping')}</h3>
                        </div>
                        <div className="mining-card-body">
                            {ankiNoteField && renderKeyField(ankiNoteField)}
                            {renderAnkiSuggestBanner()}
                            <div className="mining-two-col">{ankiCoreFields.map(renderKeyField)}</div>
                        </div>
                    </section>
                )}

                {(audioOffsets.length > 0 || ankiActionToggles.length > 0) && (
                    <section className="mining-card mining-card--compact">
                        <div className="mining-card-head">
                            <h3>{t('mining.cards.audioAndActions')}</h3>
                        </div>
                        <div className="mining-card-body">
                            <div className="mining-two-col">{audioOffsets.map(renderKeyField)}</div>
                            <div className="mining-two-col mining-key-toggles">
                                {ankiActionToggles.map(renderKeyField)}
                            </div>
                        </div>
                    </section>
                )}
            </div>
        );
    };

    const renderAnkiSuggestBanner = () => {
        if (!suggestedMappings.length) return null;
        return (
            <div className="mining-banner mining-banner--info">
                <div className="mining-banner-content">
                    <strong>
                        {t('mining.ankiSuggestTitle', { model: String(model ?? '') })}
                    </strong>
                    <ul className="mining-suggest-list">
                        {suggestedMappings.map((item) => (
                            <li key={item.path}>
                                <span>{label(item.path).name}:</span>{' '}
                                <code>{item.current || t('mining.empty')}</code> →{' '}
                                <code>{item.suggested}</code>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="mining-banner-actions">
                    <button
                        type="button"
                        className="ws-primary"
                        onClick={applySuggestedMappings}
                    >
                        {t('mining.updateFields')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setDismissedMappingModel(String(model ?? ''))}
                    >
                        {t('mining.keepCurrentFields')}
                    </button>
                </div>
            </div>
        );
    };

    const renderAnkiConfirmationPage = () => {
        const showDialogField = byPath.get('anki.show_update_confirmation_dialog_v2');
        const reviewEnabledField = byPath.get('features.review_after_session.enabled');

        const setConfirmationMaster = (enabled: boolean) => {
            if (!enabled) {
                if (showDialogField) applyFieldChange(showDialogField, false);
                if (reviewEnabledField) applyFieldChange(reviewEnabledField, false);
            } else {
                if (showDialogField) applyFieldChange(showDialogField, !afterSession);
                if (reviewEnabledField) applyFieldChange(reviewEnabledField, afterSession);
            }
        };

        const setConfirmationMode = (mode: 'immediate' | 'after_session') => {
            const isAfter = mode === 'after_session';
            if (showDialogField) applyFieldChange(showDialogField, !isAfter);
            if (reviewEnabledField) applyFieldChange(reviewEnabledField, isAfter);
        };

        const immediateCore = [
            'anki.skip_confirmation_for_unvoiced',
            'anki.auto_accept_timer',
            'anki.confirmation_audio_step',
        ].flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));

        const focusFields = [
            'anki.confirmation_always_on_top',
            'anki.confirmation_focus_on_show',
            'anki.confirmation_restore_focus',
        ].flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));

        const gamepadToggle = byPath.get('anki.confirmation_gamepad_enabled');
        const gamepadBindings = CONFIRMATION_GAMEPAD_FIELDS.flatMap((p) =>
            byPath.has(p) ? [byPath.get(p)!] : [],
        );

        const sessionReviewFields = visibleRows.filter((f) =>
            f.path.startsWith('features.review_after_session.'),
        );

        const audioPlaybackFields = [
            'anki.autoplay_audio',
            'anki.replay_audio_on_tts_generation',
        ].flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));

        return (
            <div className="mining-cards">
                <section className="mining-card">
                    <div className="mining-card-head">
                        <h3>{t('mining.cards.confirmationMode')}</h3>
                    </div>
                    <div className="mining-card-body">
                        {showDialogField && (
                            <div className="mining-row">
                                <div
                                    className="mining-label"
                                    data-tip={label(showDialogField.path).help}
                                >
                                    <label
                                        htmlFor={'mining-field-' + showDialogField.path}
                                        className="mining-label--recommended is-bold"
                                    >
                                        {label(showDialogField.path).name}
                                    </label>
                                    <ImportanceBadge importance="recommended" />
                                </div>
                                <div className="mining-control">
                                    <input
                                        id={'mining-field-' + showDialogField.path}
                                        type="checkbox"
                                        className="mining-switch"
                                        disabled={busy}
                                        checked={confirmationEnabled}
                                        onChange={(e) => setConfirmationMaster(e.target.checked)}
                                    />
                                    {inheritanceControl(showDialogField)}
                                </div>
                            </div>
                        )}

                        <div
                            className={
                                'mining-mode-cards' + (!confirmationEnabled ? ' is-disabled' : '')
                            }
                            role="radiogroup"
                            aria-label={t('mining.cards.confirmationMode')}
                        >
                            <label
                                className={
                                    'mining-mode-card' +
                                    (!afterSession && confirmationEnabled ? ' is-active' : '')
                                }
                            >
                                <input
                                    type="radio"
                                    name="anki-confirmation-mode"
                                    disabled={busy || !confirmationEnabled}
                                    checked={!afterSession}
                                    onChange={() => setConfirmationMode('immediate')}
                                />
                                <div>
                                    <strong>{t('mining.confirmationImmediate')}</strong>
                                    <span>{t('mining.confirmationImmediateDesc')}</span>
                                </div>
                            </label>
                            <label
                                className={
                                    'mining-mode-card' +
                                    (afterSession && confirmationEnabled ? ' is-active' : '')
                                }
                            >
                                <input
                                    type="radio"
                                    name="anki-confirmation-mode"
                                    disabled={busy || !confirmationEnabled}
                                    checked={afterSession}
                                    onChange={() => setConfirmationMode('after_session')}
                                />
                                <div>
                                    <strong>{t('mining.confirmationAfterSession')}</strong>
                                    <span>{t('mining.confirmationAfterSessionDesc')}</span>
                                </div>
                            </label>
                        </div>
                    </div>
                </section>

                {confirmationEnabled && afterSession && sessionReviewFields.length > 0 && (
                    <section className="mining-card">
                        <div className="mining-card-head">
                            <h3>{t('mining.sections.session_review')}</h3>
                        </div>
                        <div className="mining-card-body">
                            {sessionReviewFields.map((f) => renderFieldRow(f))}
                            <button type="button" className="mining-inline-btn"
                                onClick={() => void invokeIpc('sessionReview.open').catch((e) => setError(String(e)))}>
                                {t('cardReview.reviewNow')}
                            </button>
                        </div>
                    </section>
                )}

                {confirmationEnabled && !afterSession && (
                    <>
                        {immediateCore.length > 0 && (
                            <section className="mining-card">
                                <div className="mining-card-head">
                                    <h3>{t('mining.cards.confirmationDialog')}</h3>
                                </div>
                                <div className="mining-card-body">
                                    {immediateCore.map((f) => renderFieldRow(f))}
                                </div>
                            </section>
                        )}
                        {focusFields.length > 0 && (
                            <section className="mining-card">
                                <div className="mining-card-head">
                                    <h3>{t('mining.cards.focusBehavior')}</h3>
                                </div>
                                <div className="mining-card-body">
                                    {focusFields.map((f) => renderFieldRow(f))}
                                </div>
                            </section>
                        )}
                        {gamepadToggle && (
                            <section className="mining-card">
                                <div className="mining-card-head">
                                    <h3>{t('mining.cards.gamepadBindings')}</h3>
                                </div>
                                <div className="mining-card-body">
                                    {renderFieldRow(gamepadToggle)}
                                    {Boolean(effectiveValues['anki.confirmation_gamepad_enabled']) && (
                                        <div className="mining-gamepad-grid">
                                            {gamepadBindings.map((f) =>
                                                renderFieldRow(f, { compact: true }),
                                            )}
                                        </div>
                                    )}
                                </div>
                            </section>
                        )}
                    </>
                )}

                {confirmationEnabled && audioPlaybackFields.length > 0 && (
                    <section className="mining-card">
                        <div className="mining-card-head">
                            <h3>{t('mining.cards.confirmationAudio')}</h3>
                        </div>
                        <div className="mining-card-body">
                            {audioPlaybackFields.map((f) => renderFieldRow(f))}
                        </div>
                    </section>
                )}
            </div>
        );
    };

    const renderHotkeysPage = () => {
        const renderedPaths = new Set<string>();
        return (
            <div className="mining-cards">
                <div className="mining-banner mining-banner--info">
                    <MiningIcon name="info" size={16} />
                    <span>{t('mining.hotkeysIntro')}</span>
                </div>
                {HOTKEY_GROUPS.map((grp) => {
                    const activePairs = grp.pairs.filter(
                        (pair) => byPath.has(pair.keyboard) || (pair.gamepad && byPath.has(pair.gamepad)),
                    );
                    const flags = (grp.footerFlags ?? []).flatMap((p) =>
                        byPath.has(p) ? [byPath.get(p)!] : [],
                    );
                    if (!activePairs.length && !flags.length) return null;
                    activePairs.forEach((p) => {
                        renderedPaths.add(p.keyboard);
                        if (p.gamepad) renderedPaths.add(p.gamepad);
                    });
                    flags.forEach((f) => renderedPaths.add(f.path));

                    return (
                        <section
                            className="mining-card"
                            key={grp.id}
                        >
                            <div className="mining-card-head">
                                <h3>{t(grp.titleKey)}</h3>
                            </div>
                            <div className="mining-card-body">
                                <div className="mining-hotkey-table-head" aria-hidden="true">
                                    <span>{t('mining.action')}</span>
                                    <span>
                                        <MiningIcon name="keyboard" size={13} />
                                        {t('mining.keyboard')}
                                    </span>
                                    <span>
                                        <MiningIcon name="gamepad" size={13} />
                                        {t('mining.gamepad')}
                                    </span>
                                </div>
                                {activePairs.map((pair) => {
                                    const kbField = byPath.get(pair.keyboard);
                                    const gpField = pair.gamepad ? byPath.get(pair.gamepad) : undefined;
                                    if (!kbField) return null;
                                    const kbLabel = label(kbField.path);
                                    return (
                                        <div
                                            className="mining-hotkey-pair-row mining-row"
                                            key={pair.keyboard}
                                        >
                                            <div
                                                className="mining-label"
                                                data-tip={kbLabel.help}
                                            >
                                                <label htmlFor={'mining-field-' + kbField.path}>
                                                    {kbLabel.name}
                                                </label>
                                            </div>
                                            <div className="mining-control">
                                                <FieldInput
                                                    field={kbField}
                                                    value={effectiveValues[kbField.path]}
                                                    name={kbLabel.name}
                                                    hint={kbLabel.help}
                                                    disabled={busy || !!draft[kbField.path]?.inherit}
                                                    change={(v, inv) => change(kbField, v, inv)}
                                                    languageNames={languages}
                                                />
                                                {inheritanceControl(kbField, true)}
                                            </div>
                                            <div className="mining-control">
                                                {gpField ? (
                                                    <>
                                                        <FieldInput
                                                            field={gpField}
                                                            value={effectiveValues[gpField.path]}
                                                            name={label(gpField.path).name}
                                                            hint={label(gpField.path).help}
                                                            disabled={
                                                                busy ||
                                                                !!draft[gpField.path]?.inherit
                                                            }
                                                            change={(v, inv) =>
                                                                change(gpField, v, inv)
                                                            }
                                                            languageNames={languages}
                                                        />
                                                        {inheritanceControl(gpField, true)}
                                                    </>
                                                ) : (
                                                    <span className="mining-muted-inline">—</span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                                {flags.length > 0 && (
                                    <div className="mining-card-divider">
                                        {flags.map((f) => renderFieldRow(f))}
                                    </div>
                                )}
                            </div>
                        </section>
                    );
                })}
                {visibleRows
                    .filter((f) => !renderedPaths.has(f.path))
                    .map((f) => renderFieldRow(f))}
            </div>
        );
    };

    const renderAiSetupGuide = () => {
        const provider = String(effectiveValues['ai.provider'] ?? 'Gemini');
        const guide = AI_PROVIDER_GUIDES[provider] ?? AI_PROVIDER_GUIDES.Gemini;
        const configured = isAiProviderConfigured(effectiveValues);
        return (
            <div className="mining-ai-guide">
                <div className="mining-ai-guide-head">
                    <strong>{t('mining.aiGuide.title', { provider })}</strong>
                    <span
                        className={
                            'mining-status-pill ' +
                            (configured ? 'is-ready' : 'is-incomplete')
                        }
                    >
                        {t(configured ? 'mining.aiGuide.ready' : 'mining.aiGuide.needsSetup')}
                    </span>
                </div>
                <p>{t(guide.descriptionKey)}</p>
                {provider === 'Gemini' && (
                    <p className="mining-ai-rec-note">{t('mining.aiGuide.geminiRecommended')}</p>
                )}
                <div className="mining-ai-guide-links">
                    <button
                        type="button"
                        className="mining-link-btn"
                        onClick={() => openExternal(guide.accountUrl)}
                    >
                        <MiningIcon name="external" size={13} />
                        <span>{t('mining.aiGuide.accountLink')}</span>
                    </button>
                    <button
                        type="button"
                        className="mining-link-btn"
                        onClick={() => openExternal(guide.docsUrl)}
                    >
                        <MiningIcon name="external" size={13} />
                        <span>{t('mining.aiGuide.docsLink')}</span>
                    </button>
                </div>
            </div>
        );
    };

    const renderAudioFfmpegPresetControl = () => {
        const optsField = byPath.get('audio.ffmpeg_reencode_options');
        if (!optsField) return null;
        const currentOpts = String(effectiveValues[optsField.path] ?? '');
        const activePreset = detectAudioFfmpegPreset(currentOpts);
        const customSaved = String(effectiveValues['audio.custom_encode_settings'] ?? '');

        return (
            <div className="mining-row">
                <div
                    className="mining-label"
                    data-tip={t('mining.audioPresets.hint')}
                >
                    <label htmlFor="mining-audio-ffmpeg-preset">
                        {t('mining.audioPresets.label')}
                    </label>
                </div>
                <div className="mining-control">
                    <select
                        id="mining-audio-ffmpeg-preset"
                        disabled={busy || !!draft[optsField.path]?.inherit}
                        value={activePreset}
                        onChange={(e) => {
                            const preset = AUDIO_FFMPEG_PRESETS.find((p) => p.id === e.target.value);
                            if (!preset) return;
                            if (preset.id === 'custom') {
                                change(optsField, customSaved || currentOpts);
                            } else {
                                change(optsField, preset.options);
                            }
                        }}
                    >
                        {AUDIO_FFMPEG_PRESETS.map((preset) => (
                            <option
                                key={preset.id}
                                value={preset.id}
                            >
                                {t(preset.labelKey)}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
        );
    };

    const renderAiPromptsExtras = () => {
        const presetField = byPath.get('ai.prompt_preset');
        const customPromptField = byPath.get('ai.custom_prompt');
        const cannedTransField = byPath.get('ai.use_canned_translation_prompt');
        const cannedCtxField = byPath.get('ai.use_canned_context_prompt');
        const activePreset = String(effectiveValues['ai.prompt_preset'] ?? '');
        const nativeCode = String(effectiveValues['general.native_language'] ?? 'en');
        const nativeName = languageName(languages, nativeCode);

        const copyPresetToCustom = () => {
            if (!activePreset || !customPromptField) return;
            const built = buildStudyPrompt(activePreset, '{native_language}');
            applyFieldChange(customPromptField, built);
            if (cannedTransField) applyFieldChange(cannedTransField, false);
            if (cannedCtxField) applyFieldChange(cannedCtxField, false);
            if (presetField) applyFieldChange(presetField, '');
        };

        const runPreview = () => {
            setPromptPreview(
                renderPromptPreview({
                    nativeLanguageName: nativeName,
                    sentence: sampleSentence,
                    promptPreset: activePreset,
                    useCannedTranslation: Boolean(
                        effectiveValues['ai.use_canned_translation_prompt'],
                    ),
                    useCannedContext: Boolean(effectiveValues['ai.use_canned_context_prompt']),
                    customPrompt: String(effectiveValues['ai.custom_prompt'] ?? ''),
                    customFullPrompt: String(effectiveValues['ai.custom_full_prompt'] ?? ''),
                }),
            );
        };

        return { copyPresetToCustom, activePreset, runPreview };
    };

    const renderCardedFields = () => {
        const pageKey = `${section}.${tab}`;
        const cardDefs = SECTION_CARDS[pageKey];
        const visibleByPath = new Map(visibleRows.map((f) => [f.path, f]));

        if (!cardDefs) {
            return (
                <section className="mining-card">
                    <div className="mining-card-body">
                        {visibleRows.map((f) => renderFieldRow(f))}
                    </div>
                </section>
            );
        }

        const assigned = new Set<string>();
        const renderedCards = cardDefs
            .map((card) => {
                const cardFields = card.fields.flatMap((p) => {
                    const match = visibleByPath.get(p);
                    if (match) assigned.add(p);
                    return match ? [match] : [];
                });
                if (!cardFields.length) return null;

                const isAiProviderCard = pageKey === 'ai.general' && card.id === 'ai-provider';
                const isAudioEncodingCard = pageKey === 'audio.audio' && card.id === 'audio-encoding';
                const isAiPromptTaskCard = pageKey === 'ai.prompts' && card.id === 'ai-prompt-task';
                const isAnkiMappingsCard = pageKey === 'anki.general' && card.id === 'anki-mappings';
                const isObsRecordingCard = pageKey === 'obs.recording' && card.id === 'obs-recording';
                const isAnimatedCard =
                    pageKey === 'screenshot.general' && card.id === 'screenshot-animated';
                const promptExtras = isAiPromptTaskCard ? renderAiPromptsExtras() : null;

                return (
                    <section
                        className="mining-card"
                        key={card.id}
                    >
                        <div className="mining-card-head">
                            <h3>{t(card.titleKey)}</h3>
                            {card.descKey && (
                                <p className="mining-card-desc">{t(card.descKey)}</p>
                            )}
                            {pageKey === 'anki.field_grouping' && (
                                <button
                                    type="button"
                                    className="mining-link-btn"
                                    onClick={() => openExternal(DOCS_LINKS.kikuFieldGrouping)}
                                >
                                    <MiningIcon name="external" size={13} />
                                    <span>{t('mining.docs.kikuFieldGrouping')}</span>
                                </button>
                            )}
                            {pageKey === 'features.general' && card.id === 'longplay' && (
                                <button
                                    type="button"
                                    className="mining-link-btn"
                                    onClick={() => openExternal(DOCS_LINKS.longplay)}
                                >
                                    <MiningIcon name="external" size={13} />
                                    <span>{t('mining.docs.longplay')}</span>
                                </button>
                            )}
                        </div>
                        <div
                            className={
                                'mining-card-body' +
                                (card.compactGrid ? ' mining-easy-days-grid' : '')
                            }
                        >
                            {isObsRecordingCard && (
                                <p className="mining-inline-banner mining-inline-banner--info">
                                    {t('mining.obsFps.guidelines')}
                                </p>
                            )}
                            {isAnkiMappingsCard && renderAnkiSuggestBanner()}
                            {isAudioEncodingCard && renderAudioFfmpegPresetControl()}
                            {cardFields.map((f, idx) => (
                                <div key={f.path}>
                                    {renderFieldRow(f)}
                                    {isAiProviderCard && idx === 0 && data.target !== null && (
                                        renderAiSetupGuide()
                                    )}
                                    {isAiPromptTaskCard &&
                                        promptExtras &&
                                        f.path === 'ai.prompt_preset' && (
                                            <div className="mining-preset-action-row">
                                                <button
                                                    type="button"
                                                    className="mining-inline-btn"
                                                    disabled={busy || !promptExtras.activePreset}
                                                    onClick={promptExtras.copyPresetToCustom}
                                                >
                                                    {t('mining.copyPresetToCustom')}
                                                </button>
                                            </div>
                                        )}
                                    {isAnimatedCard &&
                                        f.path === 'screenshot.animated' &&
                                        !effectiveValues['screenshot.animated'] &&
                                        Boolean(String(effectiveValues['anki.video.name'] ?? '').trim()) && (
                                            <p className="mining-inline-banner mining-inline-banner--info">
                                                {t('mining.animatedVideoFieldNote')}
                                            </p>
                                        )}
                                </div>
                            ))}
                        </div>
                    </section>
                );
            })
            .filter(Boolean);

        const leftovers = visibleRows.filter((f) => !assigned.has(f.path));
        if (leftovers.length > 0) {
            renderedCards.push(
                <section
                    className="mining-card"
                    key="other"
                >
                    <div className="mining-card-head">
                        <h3>{t('mining.cards.other')}</h3>
                    </div>
                    <div className="mining-card-body">
                        {leftovers.map((f) => renderFieldRow(f))}
                    </div>
                </section>,
            );
        }

        // Live Prompt Preview card on AI -> Prompts (Qt parity)
        if (pageKey === 'ai.prompts') {
            const { runPreview } = renderAiPromptsExtras();
            renderedCards.push(
                <section
                    className="mining-card"
                    key="ai-prompt-preview"
                >
                    <div className="mining-card-head">
                        <h3>{t('mining.cards.promptPreview')}</h3>
                        <p className="mining-card-desc">{t('mining.promptPreviewDesc')}</p>
                    </div>
                    <div className="mining-card-body">
                        <div className="mining-row">
                            <div className="mining-label">
                                <label htmlFor="mining-prompt-sample">
                                    {t('mining.sampleSentence')}
                                </label>
                            </div>
                            <div className="mining-control">
                                <input
                                    id="mining-prompt-sample"
                                    type="text"
                                    value={sampleSentence}
                                    onChange={(e) => setSampleSentence(e.target.value)}
                                />
                                <button
                                    type="button"
                                    className="mining-inline-btn"
                                    onClick={runPreview}
                                >
                                    {t('mining.previewPrompt')}
                                </button>
                            </div>
                        </div>
                        {promptPreview && (
                            <pre className="mining-prompt-preview-box">{promptPreview}</pre>
                        )}
                    </div>
                </section>,
            );
        }

        return <div className="mining-cards">{renderedCards}</div>;
    };

    const renderSearchResults = () => {
        if (!visibleRows.length) {
            return (
                <div className="mining-empty-state">
                    <MiningIcon name="search" size={24} />
                    <p>{t('mining.noMatches')}</p>
                </div>
            );
        }
        const byGroup = new Map<string, { cat: string; sub: string; items: Field[] }>();
        for (const f of visibleRows) {
            const [cat, sub] = fieldPage(f.path);
            const bucketKey = `${cat}.${sub}`;
            let entry = byGroup.get(bucketKey);
            if (!entry) {
                entry = { cat, sub, items: [] };
                byGroup.set(bucketKey, entry);
            }
            entry.items.push(f);
        }
        return (
            <div className="mining-cards">
                {[...byGroup.entries()].map(([bucketKey, bucket]) => (
                    <section
                        className="mining-card"
                        key={bucketKey}
                    >
                        <div className="mining-card-head mining-search-card-head">
                            <h3>
                                {t('mining.sections.' + bucket.cat)}
                                {bucket.sub && bucket.sub !== 'general' && (
                                    <>
                                        {' › '}
                                        {t('mining.sections.' + bucket.sub)}
                                    </>
                                )}
                            </h3>
                            <button
                                type="button"
                                className="mining-link-btn"
                                onClick={() => {
                                    setSearch('');
                                    setManage(false);
                                    setGroup(bucket.cat);
                                    if (bucket.sub) {
                                        setSubtabs((old) => ({ ...old, [bucket.cat]: bucket.sub }));
                                    }
                                }}
                            >
                                {t('mining.openSection')}
                            </button>
                        </div>
                        <div className="mining-card-body">
                            {bucket.items.map((f) => renderFieldRow(f))}
                        </div>
                    </section>
                ))}
            </div>
        );
    };

    const sectionTitle = t(
        manage
            ? 'mining.manageProfiles'
            : search
              ? 'mining.searchResults'
              : 'mining.sections.' + section,
    );

    const pageDocLink =
        !manage && !query
            ? section === 'anki' && tab === 'general'
                ? { labelKey: 'mining.docs.anki', url: DOCS_LINKS.anki }
                : section === 'ai' && tab === 'general'
                  ? { labelKey: 'mining.docs.ai', url: DOCS_LINKS.ai }
                  : section === 'features' && tab === 'process_pausing'
                    ? { labelKey: 'mining.docs.gamePausing', url: DOCS_LINKS.gamePausing }
                    : null
            : null;

    const scopeBannerText =
        obsOnly || manage
            ? null
            : data.target === null
              ? t('mining.globalHint')
              : profile?.parent
                ? t('mining.gameHint', { base: profile.parent })
                : null;

    const nativeLangName = languageName(
        languages,
        String(effectiveValues['general.native_language'] ?? 'en'),
    );

    return (
        <div className={obsOnly ? 'mining-editor mining-obs' : 'gsm-workspace mining-editor'}>
            <header className="mining-window-head">
                {!obsOnly && (
                    <div className="mining-brand">
                        <span className="mining-brand-badge" aria-hidden="true">
                            <MiningIcon name="key_settings" size={16} />
                        </span>
                        <h1>{t('mining.title')}</h1>
                    </div>
                )}
                {!obsOnly && (
                    <div className="mining-search-box">
                        <MiningIcon name="search" size={14} />
                        <input
                            ref={searchInputRef}
                            id="mining-search"
                            type="search"
                            aria-label={t('mining.find')}
                            placeholder={t('mining.find')}
                            value={search}
                            onChange={(e) => {
                                setManage(false);
                                setSearch(e.target.value);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape' && search) {
                                    e.preventDefault();
                                    setSearch('');
                                }
                            }}
                        />
                        {query && (
                            <span className="mining-search-count">
                                {visibleRows.length}
                            </span>
                        )}
                    </div>
                )}
                <div className="mining-scope-picker">
                    <label htmlFor="mining-target">{t('mining.editing')}</label>
                    <select
                        id="mining-target"
                        title={t('mining.active', { name: data.active })}
                        disabled={locked}
                        value={JSON.stringify(data.target)}
                        onChange={(e) => choose(JSON.parse(e.target.value))}
                    >
                        <option value="null">{t('mining.global')}</option>
                        {[
                            [t('mining.profiles'), bases],
                            [t('mining.games'), games],
                        ].map(([heading, items]) => (
                            <optgroup
                                key={heading as string}
                                label={heading as string}
                            >
                                {(items as Profile[]).map((p) => (
                                    <option
                                        key={p.name}
                                        value={JSON.stringify(p.name)}
                                    >
                                        {p.name}
                                        {p.name === data.active ? ' ✓' : ''}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </div>
                {!obsOnly && profile && profile.name !== data.active && (
                    <button
                        type="button"
                        className="mining-activate-btn"
                        disabled={locked}
                        onClick={async () => {
                            setBusy(true);
                            try {
                                await invokeIpc('settings.mining.activate', {
                                    name: profile.name,
                                });
                                await load(profile.name);
                            } catch (e) {
                                setError(String(e));
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        {t('mining.activate')}
                    </button>
                )}
            </header>

            <div className="mining-body">
                {!obsOnly && (
                    <aside className="mining-sidebar">
                        <nav aria-label={t('mining.section')}>
                            {groups.map((g) => (
                                <button
                                    key={g}
                                    type="button"
                                    aria-current={
                                        !manage && !search && section === g ? 'page' : undefined
                                    }
                                    onClick={() => {
                                        setManage(false);
                                        setGroup(g);
                                        setSearch('');
                                    }}
                                >
                                    <MiningIcon name={g} size={15} />
                                    <span className="mining-nav-label">
                                        {t('mining.sections.' + g)}
                                    </span>
                                    {dirtyCategories.has(g) && (
                                        <span
                                            className="mining-dirty-dot"
                                            aria-hidden="true"
                                        />
                                    )}
                                </button>
                            ))}
                        </nav>
                        <div className="mining-sidebar-foot">
                            <button
                                type="button"
                                className="mining-manage-link"
                                aria-current={manage ? 'page' : undefined}
                                onClick={() => {
                                    setManage(true);
                                    setSearch('');
                                }}
                            >
                                <MiningIcon name="profiles" size={15} />
                                <span className="mining-nav-label">
                                    {t('mining.manageProfiles')}
                                </span>
                            </button>
                        </div>
                    </aside>
                )}

                <main
                    className={
                        'mining-page' +
                        (section === 'key_settings' && !query && !manage ? ' is-key-settings' : '')
                    }
                    ref={content}
                >
                    <div
                        className={
                            section === 'key_settings' && !query && !manage
                                ? 'mining-visually-hidden'
                                : 'mining-page-head'
                        }
                    >
                        <div className="mining-page-title-group">
                            <h2>{sectionTitle}</h2>
                            {scopeBannerText && (
                                <span className="mining-scope-pill">{scopeBannerText}</span>
                            )}
                        </div>
                        {pageDocLink && (
                            <button
                                type="button"
                                className="mining-link-btn"
                                onClick={() => openExternal(pageDocLink.url)}
                            >
                                <MiningIcon name="external" size={13} />
                                <span>{t(pageDocLink.labelKey)}</span>
                            </button>
                        )}
                    </div>

                    {!manage && !query && tabs.length > 1 && (
                        <div
                            className="mining-subtabs"
                            role="tablist"
                            aria-label={sectionTitle}
                        >
                            {tabs.map((key, index) => (
                                <button
                                    type="button"
                                    key={key}
                                    id={'mining-tab-' + key}
                                    role="tab"
                                    aria-selected={key === tab}
                                    tabIndex={key === tab ? 0 : -1}
                                    onClick={() =>
                                        setSubtabs((old) => ({ ...old, [section]: key }))
                                    }
                                    onKeyDown={(e) => {
                                        const next =
                                            e.key === 'ArrowRight'
                                                ? (index + 1) % tabs.length
                                                : e.key === 'ArrowLeft'
                                                  ? (index + tabs.length - 1) % tabs.length
                                                  : e.key === 'Home'
                                                    ? 0
                                                    : e.key === 'End'
                                                      ? tabs.length - 1
                                                      : -1;
                                        if (next < 0) return;
                                        e.preventDefault();
                                        const button =
                                            e.currentTarget.parentElement?.querySelectorAll(
                                                'button',
                                            )[next];
                                        button?.focus();
                                        button?.click();
                                    }}
                                >
                                    {t('mining.sections.' + key)}
                                </button>
                            ))}
                        </div>
                    )}

                    {manage && data.target === null && data.migrationBackup && (
                        <div className="mining-banner mining-banner--info">
                            <MiningIcon name="info" size={16} />
                            <span>
                                {t('mining.migration', {
                                    name: data.migrationProfile || '',
                                    file: data.migrationBackup,
                                })}
                            </span>
                        </div>
                    )}

                    {!manage && !query && section === 'features' && tab === 'tokenization' && (
                        <div className="mining-banner mining-banner--warning">
                            <MiningIcon name="alert" size={16} />
                            <span>{t('mining.tokenizationWarning')}</span>
                        </div>
                    )}

                    {!manage && !query && section === 'features' && tab === 'process_pausing' && (
                        <div className="mining-banner mining-banner--danger">
                            <MiningIcon name="alert" size={16} />
                            <span>{t('mining.gamePausingBanner')}</span>
                        </div>
                    )}

                    {error && (
                        <p
                            role="alert"
                            className="mining-banner mining-banner--danger"
                        >
                            {error}
                        </p>
                    )}

                    {manage && (
                        <section className="mining-card mining-scope-card">
                            <div className="mining-card-head">
                                <h3>
                                    {data.target === null
                                        ? t('mining.global')
                                        : data.target}
                                </h3>
                                {profile?.parent && (
                                    <span className="mining-scope-pill">
                                        {t('mining.gameHint', { base: profile.parent })}
                                    </span>
                                )}
                            </div>
                            <div className="mining-card-body">
                                {profile?.scenes.length ? (
                                    <p className="mining-muted-inline">
                                        {t('mining.bound', { scenes: profile.scenes.join(', ') })}
                                    </p>
                                ) : null}
                                <div className="mining-actions">
                                    <button
                                        type="button"
                                        disabled={locked}
                                        onClick={() => startNew('createProfile')}
                                    >
                                        {t('mining.newProfile')}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={locked}
                                        onClick={() => startNew('createScene')}
                                    >
                                        {t('mining.newGame')}
                                    </button>
                                    {profile &&
                                        profile.name !== 'Default' &&
                                        data.profiles.length > 1 &&
                                        !games.some((g) => g.parent === profile.name) && (
                                            <button
                                                type="button"
                                                className="danger"
                                                disabled={locked}
                                                onClick={() => {
                                                    setNewKind(null);
                                                    setDeleting(true);
                                                }}
                                            >
                                                {t('mining.remove')}
                                            </button>
                                        )}
                                </div>
                                {newKind && (
                                    <form
                                        className="mining-manage"
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            void mutate({
                                                op: newKind,
                                                base,
                                                name: newName,
                                                sceneId: scenes.find(
                                                    (s) => s.name === newName.trim(),
                                                )?.id,
                                                follow,
                                            });
                                        }}
                                    >
                                        <label>
                                            <span>{t('mining.base')}</span>
                                            <select
                                                value={base}
                                                onChange={(e) => setBase(e.target.value)}
                                            >
                                                {bases.map((p) => (
                                                    <option key={p.name}>{p.name}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label>
                                            <span>
                                                {t(
                                                    newKind === 'createScene'
                                                        ? 'mining.sceneName'
                                                        : 'mining.profileName',
                                                )}
                                            </span>
                                            <input
                                                autoFocus
                                                required
                                                value={newName}
                                                list={
                                                    newKind === 'createScene'
                                                        ? 'mining-scenes'
                                                        : undefined
                                                }
                                                onChange={(e) => setNewName(e.target.value)}
                                            />
                                        </label>
                                        <datalist id="mining-scenes">
                                            {scenes.map((s) => (
                                                <option
                                                    key={s.id || s.name}
                                                    value={s.name}
                                                />
                                            ))}
                                        </datalist>
                                        {newKind === 'createScene' && (
                                            <label className="mining-check">
                                                <input
                                                    type="checkbox"
                                                    checked={follow}
                                                    onChange={(e) => setFollow(e.target.checked)}
                                                />
                                                <span>{t('mining.follow')}</span>
                                            </label>
                                        )}
                                        <div className="mining-actions">
                                            <button
                                                className="ws-primary"
                                                disabled={locked || !newName.trim()}
                                            >
                                                {t('mining.create')}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={locked}
                                                onClick={() => setNewKind(null)}
                                            >
                                                {t('mining.cancel')}
                                            </button>
                                        </div>
                                    </form>
                                )}
                                {deleting && (
                                    <div className="mining-manage mining-delete-confirm">
                                        <p>
                                            {t('mining.confirmDelete', { name: data.target! })}
                                        </p>
                                        <div className="mining-actions">
                                            <button
                                                type="button"
                                                className="danger"
                                                disabled={busy}
                                                onClick={() =>
                                                    void mutate({
                                                        op: 'delete',
                                                        target: data.target,
                                                    })
                                                }
                                            >
                                                {t('mining.remove')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDeleting(false)}
                                            >
                                                {t('mining.cancel')}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </section>
                    )}

                    <section
                        className={
                            section === 'key_settings' && !query && !manage
                                ? 'mining-key-section'
                                : 'mining-fields'
                        }
                        aria-label={sectionTitle}
                        role={tabs.length > 1 && !query && !manage ? 'tabpanel' : undefined}
                    >
                        {groupMappings && (
                            <div className="mining-actions">
                                <button
                                    type="button"
                                    disabled={locked || saving}
                                    onClick={() => {
                                        void invokeIpc('settings.mining.recommendedAnki').catch((e) =>
                                            setError(String(e)),
                                        );
                                    }}
                                >
                                    {t('nativeDialogs.anki.title')}
                                </button>
                            </div>
                        )}
                        {query
                            ? renderSearchResults()
                            : manage
                              ? visibleRows.length > 0 && (
                                    <section className="mining-card">
                                        <div className="mining-card-head">
                                            <h3>{t('mining.sections.profiles')}</h3>
                                        </div>
                                        <div className="mining-card-body">
                                            {visibleRows.map((f) => renderFieldRow(f))}
                                        </div>
                                    </section>
                                )
                              : section === 'key_settings'
                                ? renderKeySettingsDashboard()
                                : section === 'anki' && tab === 'confirmation'
                                  ? renderAnkiConfirmationPage()
                                  : section === 'hotkeys'
                                    ? renderHotkeysPage()
                                    : renderCardedFields()}
                    </section>

                    {manage && (
                        <details className="mining-tools mining-card">
                            <summary>{t('mining.tools')}</summary>
                            <div className="mining-tools-body">
                                <p className="mining-muted-inline">{t('mining.toolsHint')}</p>
                                <button
                                    type="button"
                                    disabled={locked}
                                    data-tip={t('mining.toolsHint')}
                                    onClick={() =>
                                        void invokeIpc('settings.mining.tools', {
                                            root: section,
                                            subtab: '',
                                        }).catch((e) => setError(String(e)))
                                    }
                                >
                                    {t('mining.openTools')}
                                </button>
                            </div>
                        </details>
                    )}
                </main>
            </div>

            <span className="mining-visually-hidden" role="status">
                {saving ? t('mining.saving') : ''}
            </span>
            {(saveError || hasInvalid) && (
                <div
                    className="mining-save-notice"
                >
                    <div className="mining-save-status" role="alert">
                        {t(saveError ? 'mining.autoSaveFailed' : 'mining.autoSaveInvalid')}
                        {saveError && <div className="mining-muted-inline">{saveError}</div>}
                    </div>
                    {closeRequested && (
                        <button
                            type="button"
                            onClick={() => setCloseRequested(false)}
                        >
                            {t('mining.keepEditing')}
                        </button>
                    )}
                    <button
                        disabled={busy || saving}
                        type="button"
                        onClick={() => {
                            setDraft({});
                            setSaveError('');
                            if (!closeRequested) void load(data.target);
                        }}
                    >
                        {t(closeRequested ? 'mining.discardClose' : 'mining.discard')}
                    </button>
                    {saveError && canSave && (
                        <button
                            className="ws-primary"
                            disabled={busy || saving}
                            type="button"
                            onClick={() => void saveDraft()}
                        >
                            {t('mining.retry')}
                        </button>
                    )}
                </div>
            )}

            <PromptBuilderDialog
                open={promptBuilderOpen}
                nativeLanguageName={nativeLangName}
                onInsert={(snippet) => {
                    const field = byPath.get('ai.custom_full_prompt');
                    if (!field) return;
                    const current = String(effectiveValues[field.path] ?? '');
                    const next = current ? current + snippet : snippet;
                    applyFieldChange(field, next, !validateCustomFullPrompt(next));
                }}
                onReplace={(fullTemplate) => {
                    const field = byPath.get('ai.custom_full_prompt');
                    if (!field) return;
                    applyFieldChange(field, fullTemplate, !validateCustomFullPrompt(fullTemplate));
                }}
                onClose={() => setPromptBuilderOpen(false)}
            />

            {dangerPrompt && (
                <ConfirmDangerDialog
                    title={t(
                        dangerPrompt === 'process_pausing'
                            ? 'mining.confirmPausing.title'
                            : 'mining.confirmDisableStats.title',
                    )}
                    message={t(
                        dangerPrompt === 'process_pausing'
                            ? 'mining.confirmPausing.message'
                            : 'mining.confirmDisableStats.message',
                    )}
                    confirmLabel={t(
                        dangerPrompt === 'process_pausing'
                            ? 'mining.confirmPausing.confirm'
                            : 'mining.confirmDisableStats.confirm',
                    )}
                    cancelLabel={t('mining.cancel')}
                    onCancel={() => setDangerPrompt(null)}
                    onConfirm={() => {
                        const targetPath =
                            dangerPrompt === 'process_pausing'
                                ? 'process_pausing.enabled'
                                : 'advanced.dont_collect_stats';
                        const field = byPath.get(targetPath);
                        if (field) applyFieldChange(field, true);
                        setDangerPrompt(null);
                    }}
                />
            )}
        </div>
    );
}
