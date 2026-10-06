import { useEffect, useRef, useState } from 'react';
import type { GameBackgroundOptions, GameBackgroundState } from '../../../shared/game_background';
import { useTranslation } from '../i18n';
import { invokeIpc } from '../lib/ipc';

export function GameBackgroundSettings({ sceneId, active }: { sceneId: string; active: boolean }) {
    const t = useTranslation();
    const [state, setState] = useState<GameBackgroundState | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const revision = useRef(0);
    const savingRef = useRef(false);
    useEffect(() => {
        setState(null);
        setError('');
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            if (!savingRef.current) {
                const current = ++revision.current;
                try {
                    const next = await invokeIpc<GameBackgroundState>('game-background.getState');
                    if (!cancelled && current === revision.current) setState(next);
                } catch (problem) {
                    if (!cancelled && current === revision.current) setError(String(problem));
                }
            }
            if (!cancelled) timer = setTimeout(refresh, 2500);
        };
        if (active) void refresh();
        return () => { cancelled = true; ++revision.current; clearTimeout(timer); };
    }, [sceneId, active]);

    const matches = state?.sceneId === sceneId;
    const ready = matches && Boolean(state?.target);
    const save = async (patch: Partial<GameBackgroundOptions>) => {
        if (!state?.target || !matches || savingRef.current) return;
        const current = ++revision.current;
        savingRef.current = true;
        setSaving(true);
        setError('');
        try {
            const next = await invokeIpc<GameBackgroundState>('game-background.save', {
                sceneId, target: state.target, options: { ...state.options, ...patch },
            });
            if (current === revision.current) setState(next);
        } catch (problem) { if (current === revision.current) setError(String(problem)); }
        finally { savingRef.current = false; setSaving(false); }
    };
    const reason = state?.reason;
    return <fieldset className="game-background-settings" disabled={!ready || saving}>
        <legend>{t('gameBackground.title')}</legend>
        <p className="game-background-help">{t('gameBackground.help')}</p>
        <label className="game-background-option">
            <input type="checkbox" checked={ready && state?.options.enabled === true}
                onChange={event => void save({ enabled: event.target.checked })} />
            <span>{t('gameBackground.enabled')}</span>
        </label>
        <label className="game-background-option">
            <input type="checkbox" checked={state?.options.keepRendering ?? true}
                onChange={event => void save({ keepRendering: event.target.checked })} />
            <span>{t('gameBackground.keepRendering')}</span>
        </label>
        <label className="game-background-option">
            <input type="checkbox" checked={state?.options.blockGamepad ?? true}
                onChange={event => void save({ blockGamepad: event.target.checked })} />
            <span>{t('gameBackground.blockGamepad')}</span>
        </label>
        <p role="status" className="game-background-help">
            {reason ? t(`gameBackground.reason.${reason}`) :
                t(`gameBackground.status.${matches ? state.phase : 'waiting'}`)}
            {ready && state.target && <> {t('gameBackground.target', { name: state.target.title, pid: state.target.pid })}</>}
        </p>
        {matches && state.telemetry && state.phase === 'active' && <p className="game-background-help">
            {t('gameBackground.blockedReads', { count: state.telemetry.blockedCalls })}
            {state.options.blockGamepad && state.telemetry.inputHooks === 0 && <> {t('gameBackground.noInput')}</>}
            {state.telemetry.errors !== 0 && <> {t('gameBackground.partial')}</>}
        </p>}
        {(error || (matches && state?.error)) && <p role="alert">
            {t('gameBackground.error', { error: error || state?.error || '' })}
        </p>}
        {matches && state?.phase === 'error' && <button type="button" className="home-text-btn" onClick={() => void save({})}>
            {t('gameBackground.retry')}
        </button>}
        <p className="game-background-help">{t('gameBackground.limitations')}</p>
    </fieldset>;
}
