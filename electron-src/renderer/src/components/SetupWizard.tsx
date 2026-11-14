import { useCallback, useEffect, useRef, useState } from 'react';
import { SUPPORTED_LOCALES, useLocale, useTranslation } from '../i18n';
import { invokeIpc } from '../lib/ipc';
import { retainEqual, startVisiblePolling } from '../lib/visiblePolling';
import { WorkspaceIcon } from './Workspace';
import {
  ONBOARDING_STEPS, ONBOARDING_VERSION,
  type DictionarySetupStatus, type OnboardingSnapshot, type OnboardingStep, type SudachiSetupStatus,
} from '../../../shared/onboarding';
import './SetupWizard.css';

interface SetupWizardProps {
  onComplete: () => void;
  onAction: (action: 'game' | 'capture' | 'settings') => void;
}

const LEARNING_LANGUAGES = ['ja', 'zh', 'ko', 'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'uk', 'ar', 'hi', 'tr', 'nl', 'sv', 'fi', 'da', 'no'];
const STEP_ICONS = ['general', 'search', 'play', 'capture', 'check'];

export function SetupWizard({ onComplete, onAction }: SetupWizardProps) {
  const t = useTranslation();
  const [locale, setLocale] = useLocale();
  const [step, setStep] = useState<OnboardingStep>('language');
  const [language, setLanguage] = useState('ja');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(false);
  const [docked, setDocked] = useState(false);
  const [dictionary, setDictionary] = useState<DictionarySetupStatus | null>(null);
  const [dictionaryError, setDictionaryError] = useState(false);
  const [sudachi, setSudachi] = useState<SudachiSetupStatus | null>(null);
  const [sudachiEdition, setSudachiEdition] = useState('small');
  const sudachiEditionLoaded = useRef(false);
  const [readerChanging, setReaderChanging] = useState(false);
  const [hasGame, setHasGame] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const index = ONBOARDING_STEPS.indexOf(step);

  const load = useCallback(async () => {
    setError(false);
    try {
      const snapshot = await invokeIpc<OnboardingSnapshot>('settings.onboarding.get');
      setStep(snapshot.progress.status === 'completed' ? 'language' : snapshot.progress.step);
      setLanguage(snapshot.targetLanguage);
      setLoaded(true);
    } catch { setError(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (docked) return;
    const previous = document.activeElement as HTMLElement | null;
    const background = Array.from(document.querySelectorAll<HTMLElement>('.app-root > main, .app-root > .tab-bar'));
    const inert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    heading.current?.focus();
    return () => {
      background.forEach((element, i) => { element.inert = inert[i]; });
      if (previous?.isConnected) previous.focus();
    };
  }, [docked]);
  useEffect(() => { if (!docked) heading.current?.focus(); }, [step, loaded, docked]);

  const saveProgress = useCallback(async (next: OnboardingStep, status: 'active' | 'paused' | 'completed' = 'active') => {
    const result = await invokeIpc<{ success: boolean }>('settings.onboarding.save', { version: ONBOARDING_VERSION, step: next, status });
    if (result?.success !== true) throw new Error('Setup progress was not saved.');
    setStep(next);
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    try { await action(); } catch { setError(true); }
    finally { busyRef.current = false; setBusy(false); }
  };

  useEffect(() => {
    if (!loaded || step !== 'dictionary' || readerChanging) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await invokeIpc<DictionarySetupStatus>('settings.onboarding.dictionary', { action: 'status' });
        if (!disposed) { setDictionary(before => retainEqual(before, next)); setDictionaryError(false); }
      } catch { if (!disposed) setDictionaryError(true); }
    };
    const stop = startVisiblePolling(refresh, 2000);
    return () => { disposed = true; stop(); };
  }, [loaded, step, readerChanging]);

  useEffect(() => {
    if (!loaded || step !== 'dictionary' || language !== 'ja') return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await invokeIpc<SudachiSetupStatus>('settings.onboarding.sudachi', { action: 'status' });
        if (!disposed) {
          setSudachi(before => retainEqual(before, next));
          if (next.dictionary && !sudachiEditionLoaded.current) { setSudachiEdition(next.dictionary); sudachiEditionLoaded.current = true; }
        }
      } catch { if (!disposed) setSudachi({ state: 'error' }); }
    };
    const stop = startVisiblePolling(refresh, 2000);
    return () => { disposed = true; stop(); };
  }, [loaded, step, language]);

  useEffect(() => {
    if (!loaded || !['game', 'capture'].includes(step)) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const scenes = await invokeIpc<Array<{ name: string }>>('obs.getScenes');
        if (!disposed) setHasGame(Array.isArray(scenes) && scenes.some(scene => !/^GSM[ _-]+HELPER/i.test(scene.name)));
      } catch { if (!disposed) setHasGame(false); }
    };
    const stop = startVisiblePolling(refresh, 2000);
    return () => { disposed = true; stop(); };
  }, [loaded, step]);

  const next = (skip = false) => run(async () => {
    if (step === 'language' && !skip) {
      const result = await invokeIpc<{ success: boolean }>('settings.saveSettings', { locale });
      if (result?.success !== true) throw new Error('App language could not be saved.');
      const saved = await invokeIpc<{ success: boolean }>('settings.onboarding.language', language);
      if (saved?.success !== true) throw new Error('Learning language could not be saved.');
    }
    if (step === 'finish') {
      await saveProgress(step, 'completed');
      onComplete();
    } else {
      await saveProgress(ONBOARDING_STEPS[index + 1]);
      setDocked(false);
    }
  });
  const pause = () => run(async () => {
    if (loaded) await saveProgress(step, 'paused');
    onComplete();
  });
  const explore = (action: 'game' | 'capture' | 'settings') => run(async () => {
    await saveProgress(step);
    setDocked(true);
    onAction(action);
  });
  const dictionaryAction = (action: 'open' | 'install') => run(async () => {
    setDictionary(await invokeIpc<DictionarySetupStatus>('settings.onboarding.dictionary', { action }));
  });
  const selectReader = (reader: 'yomitan' | 'hachidori') => run(async () => {
    if (dictionary?.reader === reader) return;
    setReaderChanging(true);
    try {
      await invokeIpc('settings.onboarding.dictionary', { action: 'select', reader });
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const state = await invokeIpc<DictionarySetupStatus>('settings.onboarding.dictionary', { action: 'status' });
          if (state.reader === reader) { setDictionary(state); return; }
        } catch { /* The previous reader closes its connection during restart. */ }
      }
      throw new Error('Dictionary reader did not restart.');
    } finally { setReaderChanging(false); }
  });

  const sudachiReady = (sudachi?.state === 'ready' || sudachi?.state === 'installed') && sudachi.dictionary === sudachiEdition;
  const ready = step === 'dictionary' ? (dictionary?.installed.length ?? 0) > 0 && (language !== 'ja' || sudachiReady) : step === 'game' ? hasGame : true;
  const languageNames = new Intl.DisplayNames([locale === 'ukr' ? 'uk' : locale], { type: 'language' });
  const languages = [...new Set([...LEARNING_LANGUAGES, language])];
  if (docked) return (
    <aside className="setup-guide" aria-label={t('onboarding.title')}>
      <WorkspaceIcon name={STEP_ICONS[index]} />
      <div><strong>{t(`onboarding.steps.${step}`)}</strong><span>{t(`onboarding.${step}Guide`)}</span></div>
      <button type="button" onClick={() => setDocked(false)}>{t('onboarding.return')}</button>
      <button type="button" disabled={busy} onClick={pause}>{t('onboarding.pause')}</button>
      {error && <span role="alert">{t('onboarding.error')}</span>}
    </aside>
  );

  return (
    <div className="setup-overlay">
      <div className="setup-card" role="dialog" aria-modal="true" aria-labelledby="setup-heading" ref={card}
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); void pause(); }
          if (event.key !== 'Tab') return;
          const controls = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), a[href]') ?? []);
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <aside className="setup-sidebar">
          <span className="setup-brand">{t('onboarding.brand')}</span>
          <h2>{t('onboarding.title')}</h2><p>{t('onboarding.subtitle')}</p>
          <ol aria-label={t('onboarding.progress')}>
            {ONBOARDING_STEPS.map((item, i) => <li key={item} aria-current={item === step ? 'step' : undefined} data-past={i < index}>
              <span className="setup-step-number">{i < index ? <WorkspaceIcon name="check" /> : i + 1}</span>{t(`onboarding.steps.${item}`)}
            </li>)}
          </ol>
          <span className="setup-sidebar-note">{t('onboarding.savedHint')}</span>
        </aside>
        <div className="setup-main">
          <div className="setup-content" aria-busy={busy}>
            <span className="setup-eyebrow">{t('onboarding.stepOf', { step: index + 1, total: ONBOARDING_STEPS.length })}</span>
            <h1 id="setup-heading" tabIndex={-1} ref={heading}>{t(`onboarding.${step}Title`)}</h1>
            <p className="setup-lede">{t(`onboarding.${step}Description`)}</p>
            {!loaded ? <button type="button" onClick={() => void load()}>{t(error ? 'onboarding.retry' : 'onboarding.loading')}</button> : <>
              {step === 'language' && <div className="setup-fields">
                <label htmlFor="setup-locale">{t('onboarding.appLanguage')}</label>
                <select id="setup-locale" value={locale} disabled={busy} onChange={event => setLocale(event.target.value)}>
                  {SUPPORTED_LOCALES.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
                </select>
                <label htmlFor="setup-language">{t('onboarding.learningLanguage')}</label>
                <select id="setup-language" value={language} disabled={busy} onChange={event => setLanguage(event.target.value)}>
                  {languages.map(value => <option key={value} value={value}>{languageNames.of(value) ?? value}</option>)}
                </select><p className="setup-note">{t('onboarding.languageHint')}</p>
              </div>}
              {step === 'dictionary' && <>
                {language === 'ja' && <div className="setup-info">
                  <h3>{t('onboarding.sudachiTitle')}</h3>
                  <p>{t('onboarding.sudachiDescription')}</p>
                  <label htmlFor="sudachi-edition">{t('onboarding.sudachiEdition')}</label>
                  <select id="sudachi-edition" value={sudachiEdition} disabled={busy || sudachi?.state === 'installing'}
                    onChange={event => setSudachiEdition(event.target.value)}>
                    {['small', 'core', 'full'].map(edition => <option key={edition} value={edition}>{t(`onboarding.sudachi${edition}`)}</option>)}
                  </select>
                  <button type="button" disabled={busy || sudachi?.state === 'installing'} onClick={() => void run(async () => {
                    setSudachi(await invokeIpc<SudachiSetupStatus>('settings.onboarding.sudachi', { action: 'install', dictionary: sudachiEdition }));
                  })}>{t(sudachi?.state === 'error' ? 'onboarding.retry' : 'onboarding.sudachiInstall')}</button>
                  <p role="status">{t(sudachiReady ? 'onboarding.sudachiReady' : sudachi?.state === 'installing' ? 'onboarding.installing' : 'onboarding.sudachiRequired')}</p>
                  {sudachi?.state === 'error' && <p role="alert">{t('onboarding.sudachiError')} {sudachi.error}</p>}
                </div>}
                <div className="setup-choices" role="group" aria-label={t('onboarding.reader')}>
                  {(['yomitan', 'hachidori'] as const).map(reader => <button type="button" key={reader} aria-pressed={dictionary?.reader === reader}
                    disabled={busy || !dictionary || dictionary.busy} onClick={() => void selectReader(reader)}>
                    <strong>{t(`onboarding.${reader}`)}</strong><span>{t(`onboarding.${reader}Hint`)}</span>
                  </button>)}
                </div>
                <div className="setup-dictionary" aria-live="polite"><WorkspaceIcon name="search" />
                  <div><strong>{dictionary?.recommended?.name ?? t('onboarding.chooseDictionary')}</strong>
                    <p>{t(dictionary?.recommended ? 'onboarding.dictionaryHint' : 'onboarding.manualDictionary')}</p>
                    {dictionary?.recommended && <button type="button" className="setup-link" onClick={() => void run(async () => {
                      const result = await invokeIpc<{ success: boolean }>('open-external', dictionary.recommended!.homepage);
                      if (result?.success === false) throw new Error('Could not open dictionary website.');
                    })}>{t('onboarding.dictionarySource')}</button>}
                  </div>
                </div>
                <div className="setup-actions">
                  {dictionary?.recommended && <button type="button" className="setup-primary" disabled={busy || dictionary.busy} onClick={() => void dictionaryAction('install')}>
                    {t(dictionary.busy ? 'onboarding.installing' : 'onboarding.installDictionary', { name: dictionary.recommended.name })}
                  </button>}
                  <button type="button" disabled={busy || dictionary?.busy} onClick={() => void dictionaryAction('open')}>{t('onboarding.dictionarySettings')}</button>
                </div>
                <p className="setup-status" role="status">{t(readerChanging ? 'onboarding.switching' : dictionary?.busy ? 'onboarding.installing' : ready ? 'onboarding.dictionaryReady' : 'onboarding.dictionaryWaiting')}</p>
                {(dictionaryError || dictionary?.error) && <p className="setup-error" role="alert">{t('onboarding.dictionaryError')}{dictionary?.error && <span>{dictionary.error}</span>}</p>}
              </>}
              {step === 'game' && <>
                <ol className="setup-instructions"><li>{t('onboarding.gameStart')}</li><li>{t('onboarding.gameSelect')}</li><li>{t('onboarding.gamePreview')}</li></ol>
                <button type="button" className="setup-primary" disabled={busy} onClick={() => void explore('game')}>{t('onboarding.addGame')}</button>
                <p className="setup-status" role="status">{t(hasGame ? 'onboarding.gameReady' : 'onboarding.gameWaiting')}</p>
              </>}
              {step === 'capture' && <>
                <div className="setup-info"><h3>{t('onboarding.hookTitle')}</h3><p>{t('onboarding.hookDescription')}</p></div>
                <div className="setup-info"><h3>{t('onboarding.ocrTitle')}</h3><p>{t('onboarding.ocrDescription')}</p></div>
                <button type="button" className="setup-primary" disabled={busy || !hasGame} onClick={() => void explore('capture')}>{t('onboarding.configureCapture')}</button>
                <p className="setup-note">{t('onboarding.captureHint')}</p>
              </>}
              {step === 'finish' && <>
                <ol className="setup-instructions"><li>{t('onboarding.tourHome')}</li><li>{t('onboarding.tourLookup')}</li><li>{t('onboarding.tourText')}</li></ol>
                <div className="setup-info"><h3>{t('onboarding.ankiTitle')}</h3><p>{t('onboarding.ankiDescription')}</p>
                  <button type="button" disabled={busy} onClick={() => void explore('settings')}>{t('onboarding.openSettings')}</button>
                </div>
                <button type="button" className="setup-link" disabled={busy} onClick={() => void run(async () => { await invokeIpc('openTexthooker'); })}>{t('onboarding.openText')}</button>
              </>}
            </>}
            {error && <p className="setup-error" role="alert">{t('onboarding.error')}</p>}
          </div>
          <footer className="setup-footer">
            <button type="button" className="setup-link" disabled={busy} onClick={pause}>{t('onboarding.pause')}</button>
            <div>
              {index > 0 && <button type="button" disabled={busy || !loaded} onClick={() => void run(() => saveProgress(ONBOARDING_STEPS[index - 1]))}>{t('onboarding.back')}</button>}
              {step !== 'finish' && <button type="button" className="setup-link" disabled={busy || !loaded} onClick={() => void next(true)}>{t('onboarding.skip')}</button>}
              <button type="button" className="setup-primary" disabled={busy || !loaded || !ready} onClick={() => void next()}>
                {t(busy ? 'onboarding.saving' : step === 'finish' ? 'onboarding.finish' : 'onboarding.next')}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
