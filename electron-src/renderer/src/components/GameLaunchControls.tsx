import { useEffect, useRef, useState } from 'react';
import { normalizeGameLaunchOptions, type GameLaunchOptions, type GameLaunchResult } from '../../../shared/game_launcher';
import { useTranslation } from '../i18n';
import { invokeIpc } from '../lib/ipc';
import { WorkspaceIcon } from './Workspace';

export function GameLaunchControls({ sceneId, active }: { sceneId: string; active: boolean }) {
    const t = useTranslation();
    const [options, setOptions] = useState(() => normalizeGameLaunchOptions(null));
    const [draft, setDraft] = useState(options);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState<GameLaunchResult | null>(null);
    const dirty = useRef(false);
    const working = useRef(false);
    const generation = useRef(0);
    const executableInput = useRef<HTMLInputElement>(null);
    const focusExecutable = useRef(false);

    useEffect(() => {
        const current = ++generation.current;
        if (!active) return;
        let timer: ReturnType<typeof setTimeout>;
        working.current = false;
        setBusy(false);
        const refresh = async () => {
            if (!dirty.current && !working.current) {
                try {
                    const next = normalizeGameLaunchOptions(await invokeIpc('game-launcher.getOptions', sceneId));
                    if (current === generation.current && !dirty.current && !working.current) {
                        setOptions(next);
                        setDraft(next);
                        setLoading(false);
                    }
                } catch {
                    if (current === generation.current) {
                        setLoading(false);
                        setError({ success: false, code: 'failed' });
                    }
                }
            }
            if (current === generation.current) timer = setTimeout(refresh, 5000);
        };
        void refresh();
        return () => { ++generation.current; clearTimeout(timer); };
    }, [sceneId, active]);

    useEffect(() => {
        if (open && focusExecutable.current) {
            executableInput.current?.focus();
            focusExecutable.current = false;
        }
    }, [open]);

    const edit = (patch: Partial<GameLaunchOptions>) => {
        dirty.current = true;
        setDraft(previous => ({ ...previous, ...patch }));
        setMessage('');
        setError(null);
    };

    const perform = async (work: (current: number) => Promise<void>) => {
        if (working.current || !active) return;
        const current = generation.current;
        working.current = true;
        setBusy(true);
        setMessage('');
        setError(null);
        try { await work(current); }
        catch (problem) {
            if (current === generation.current) setError({ success: false, code: 'failed', error: String(problem) });
        } finally {
            if (current === generation.current) { working.current = false; setBusy(false); }
        }
    };

    const save = async (current: number): Promise<boolean> => {
        const result = await invokeIpc<GameLaunchResult>('game-launcher.save', sceneId, draft);
        if (current !== generation.current) return false;
        if (!result?.success) { setError(result ?? { success: false, code: 'failed' }); return false; }
        const saved = normalizeGameLaunchOptions(draft);
        dirty.current = false;
        setOptions(saved);
        setDraft(saved);
        setLoading(false);
        setMessage('gameLauncher.saved');
        return true;
    };

    const launch = () => {
        if (!draft.executablePath.trim()) {
            focusExecutable.current = true;
            setOpen(true);
            executableInput.current?.focus();
            setMessage('gameLauncher.chooseExecutable');
            return;
        }
        void perform(async current => {
            if (dirty.current && !await save(current)) return;
            if (current !== generation.current) return;
            const result = await invokeIpc<GameLaunchResult>('game-launcher.launch', sceneId);
            if (current !== generation.current) return;
            setError(result?.success ? null : result ?? { success: false, code: 'failed' });
            setMessage(result?.success ? 'gameLauncher.launched' : '');
        });
    };

    const browse = (field: 'executablePath' | 'launcherPath' | 'workingDirectory') => void perform(async current => {
        const selected = await invokeIpc<string | null>('game-launcher.browse', field === 'workingDirectory' ? 'directory' : 'executable');
        if (current === generation.current && selected) edit({ [field]: selected });
    });

    const field = (name: 'executablePath' | 'launcherPath' | 'workingDirectory', id: string) => <div className="home-row">
        <label className="home-row__label" htmlFor={id}>{t(`gameLauncher.${name}`)}</label>
        <div className="home-row__controls">
            <input ref={name === 'executablePath' ? executableInput : undefined} className="home-input" id={id}
                type="text" autoComplete="off" spellCheck={false} value={draft[name]}
                placeholder={name === 'workingDirectory' ? t('gameLauncher.gameFolder') : undefined}
                onChange={event => edit({ [name]: event.target.value })} />
            <button type="button" className="home-text-btn" data-browse={name} onClick={() => browse(name)}
                aria-label={t('gameLauncher.browseField', { field: t(`gameLauncher.${name}`) })}>{t('gameLauncher.browse')}</button>
        </div>
    </div>;

    return <section className="home-game-launch" aria-label={t('gameLauncher.title')}>
        <div className="home-game-launch__actions">
            <button type="button" className="ws-primary" disabled={loading || busy || !active} onClick={launch}>
                <WorkspaceIcon name="play" />{t(busy ? 'gameLauncher.working' : 'gameLauncher.launch')}
            </button>
            <button type="button" className="home-text-btn" aria-expanded={open} aria-controls="home-game-launch-options"
                disabled={busy || !active} onClick={() => setOpen(value => !value)}>{t('gameLauncher.options')}</button>
        </div>
        {open && <form id="home-game-launch-options" className="home-game-launch__options" onSubmit={event => {
            event.preventDefault();
            void perform(async current => { await save(current); });
        }}>
            <fieldset disabled={busy || !active}>
                <p className="home-section-hint">{t('gameLauncher.help')}</p>
                {field('executablePath', 'game-launch-executable')}
                <div className="home-row">
                    <span className="home-row__label" />
                    <div className="home-row__controls">
                        <button type="button" className="home-text-btn" onClick={() => void perform(async current => {
                            const detected = await invokeIpc<string | null>('game-launcher.detect', sceneId);
                            if (current !== generation.current) return;
                            if (detected) edit({ executablePath: detected });
                            else setMessage('gameLauncher.notDetected');
                        })}>{t('gameLauncher.detect')}</button>
                    </div>
                </div>
                <div className="home-row">
                    <label className="home-row__label" htmlFor="game-launch-arguments">{t('gameLauncher.arguments')}</label>
                    <div className="home-row__controls">
                        <input className="home-input" id="game-launch-arguments" type="text" autoComplete="off" spellCheck={false}
                            value={draft.arguments} onChange={event => edit({ arguments: event.target.value })} />
                    </div>
                </div>
                {field('workingDirectory', 'game-launch-directory')}
                <div className="home-game-launch__custom">
                    {field('launcherPath', 'game-launch-launcher')}
                    <p className="home-section-hint">{t('gameLauncher.launcherHelp')}</p>
                    {draft.launcherPath && <>
                        <div className="home-row">
                            <label className="home-row__label" htmlFor="game-launch-launcher-arguments">{t('gameLauncher.launcherArguments')}</label>
                            <div className="home-row__controls">
                                <input className="home-input" id="game-launch-launcher-arguments" type="text" autoComplete="off" spellCheck={false}
                                    aria-describedby="game-launch-template-hint" value={draft.launcherArguments}
                                    onChange={event => edit({ launcherArguments: event.target.value })} />
                            </div>
                        </div>
                        <p id="game-launch-template-hint" className="home-section-hint">{t('gameLauncher.templateHelp')}</p>
                    </>}
                </div>
                <div className="home-game-launch__actions">
                    <button type="submit" className="home-text-btn">{t('gameLauncher.save')}</button>
                    <button type="button" className="home-text-btn" onClick={() => {
                        dirty.current = false; setDraft(options); setOpen(false); setError(null); setMessage('');
                    }}>{t('gameLauncher.cancel')}</button>
                </div>
            </fieldset>
        </form>}
        {message && <p className="home-section-hint" role="status">{t(message)}</p>}
        {error && <p className="home-game-launch__error" role="alert">
            {t(`gameLauncher.errors.${error.code ?? 'failed'}`, { error: error.error ?? '' })}
        </p>}
    </section>;
}
