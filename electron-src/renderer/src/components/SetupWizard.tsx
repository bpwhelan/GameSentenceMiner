import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SUPPORTED_LOCALES, useLocale, useTranslation } from '../i18n';
import { invokeIpc } from '../lib/ipc';
import { retainEqual, startVisiblePolling } from '../lib/visiblePolling';
import { WorkspaceIcon } from './Workspace';
import {
  ONBOARDING_STEPS, ONBOARDING_VERSION,
  type DictionarySetupStatus, type OnboardingSnapshot, type OnboardingStep,
} from '../../../shared/onboarding';
import './SetupWizard.css';

interface SetupWizardProps {
  onComplete: () => void;
  onGuideStep: (step: 'game' | 'capture' | null) => void;
  canTextHook: boolean;
  downloads?: ReactNode;
}

const LEARNING_LANGUAGES = ['ja', 'zh', 'ko', 'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'uk', 'ar', 'hi', 'tr', 'nl', 'sv', 'fi', 'da', 'no'];

export function SetupWizard({ onComplete, onGuideStep, canTextHook, downloads }: SetupWizardProps) {
  const t = useTranslation();
  const [locale, setLocale] = useLocale();
  const [step, setStep] = useState<OnboardingStep>('language');
  const [language, setLanguage] = useState('ja');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(false);
  const guidedStep = loaded && (step === 'game' || step === 'capture') ? step : null;
  useEffect(() => {
    onGuideStep(guidedStep);
    return () => onGuideStep(null);
  }, [guidedStep, onGuideStep]);
  const [dictionary, setDictionary] = useState<DictionarySetupStatus | null>(null);
  const [dictionaryError, setDictionaryError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [watchInstall, setWatchInstall] = useState(false);
  const savedLanguage = useRef('ja');
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
      savedLanguage.current = snapshot.targetLanguage;
      setLoaded(true);
    } catch { setError(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (guidedStep) return;
    const previous = document.activeElement as HTMLElement | null;
    const background = Array.from(document.querySelectorAll<HTMLElement>('.app-root > main, .app-root > .tab-bar'));
    const inert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    return () => {
      background.forEach((element, i) => { element.inert = inert[i]; });
      if (previous?.isConnected) previous.focus();
    };
  }, [guidedStep]);
  useEffect(() => { heading.current?.focus(); }, [step, loaded]);

  const saveProgress = async (nextStep: OnboardingStep, status: 'active' | 'paused' | 'completed' = 'active') => {
    const result = await invokeIpc<{ success: boolean }>('settings.onboarding.save', { version: ONBOARDING_VERSION, step: nextStep, status });
    if (result?.success !== true) throw new Error('Setup progress was not saved.');
    setStep(nextStep);
  };
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    try { await action(); } catch { setError(true); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const pollDictionary = step === 'dictionary' || (watchInstall && dictionary?.busy);
  useEffect(() => {
    if (!loaded || !pollDictionary || busy) return;
    let disposed = false;
    const stop = startVisiblePolling(async () => {
      try {
        const state = await invokeIpc<DictionarySetupStatus>('settings.onboarding.dictionary', { action: 'status' });
        if (!disposed) {
          setDictionary(before => retainEqual(before, state));
          setDictionaryError(false);
          if (state.busy) setWatchInstall(true);
        }
      } catch { if (!disposed) setDictionaryError(true); }
    }, 2000);
    return () => { disposed = true; stop(); };
  }, [loaded, pollDictionary, busy]);

  useEffect(() => {
    if (guidedStep !== 'game') return;
    let disposed = false;
    const stop = startVisiblePolling(async () => {
      try {
        const scenes = await invokeIpc<Array<{ name: string }>>('obs.getScenes');
        if (!disposed) setHasGame(Array.isArray(scenes) && scenes.some(scene => !/^GSM[ _-]+HELPER/i.test(scene.name)));
      } catch { if (!disposed) setHasGame(false); }
    }, 2000);
    return () => { disposed = true; stop(); };
  }, [guidedStep]);

  const next = (skip = false) => run(async () => {
    if (step === 'language' && !skip) {
      const result = await invokeIpc<{ success: boolean }>('settings.saveSettings', { locale });
      if (result?.success !== true) throw new Error('App language could not be saved.');
      const saved = await invokeIpc<{ success: boolean }>('settings.onboarding.language', language);
      if (saved?.success !== true) throw new Error('Learning language could not be saved.');
      if (language !== savedLanguage.current) { setDictionary(null); setWatchInstall(false); setActionError(null); }
      savedLanguage.current = language;
    } else if (step === 'language') {
      setLanguage(savedLanguage.current);
    }
    if (step === 'finish') {
      await saveProgress(step, 'completed');
      onComplete();
    } else {
      await saveProgress(ONBOARDING_STEPS[index + 1]);
    }
  });
  const pause = () => run(async () => {
    if (loaded) await saveProgress(step, 'paused');
    onComplete();
  });
  const dictionaryAction = (action: 'open' | 'install') => run(async () => {
    setActionError(null);
    try {
      const state = await invokeIpc<DictionarySetupStatus>('settings.onboarding.dictionary', { action });
      setDictionary(state);
      if (action === 'install') setWatchInstall(true);
    } catch (cause) {
      setActionError(String(cause));
    }
  });
  const selectReader = (reader: 'yomitan' | 'hachidori') => run(async () => {
    if (dictionary?.reader === reader) return;
    setActionError(null);
    setReaderChanging(true);
    try {
      await invokeIpc('settings.onboarding.dictionary', { action: 'select', reader });
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const state = await invokeIpc<DictionarySetupStatus>('settings.onboarding.dictionary', { action: 'status' });
          if (state.reader === reader) { setDictionary(state); setWatchInstall(false); return; }
        } catch { /* The previous reader closes its connection during restart. */ }
      }
      throw new Error('Dictionary reader did not restart.');
    } finally { setReaderChanging(false); }
  });

  const dictionaryIssue = actionError || dictionary?.error;
  const dictionaryReady = Boolean(dictionary?.installed.length);
  const dictionaryStatus = dictionary?.busy ? t('onboarding.installing')
    : dictionaryReady ? t('onboarding.dictionaryReady', { name: dictionary!.installed.join(', ') })
    : t('onboarding.dictionaryWaiting');
  const ready = step === 'dictionary' ? dictionaryReady || dictionary?.busy : step !== 'game' || hasGame;
  const languageNames = new Intl.DisplayNames([locale === 'ukr' ? 'uk' : locale], { type: 'language' });
  const languages = [...new Set([...LEARNING_LANGUAGES, language])];
  const dictionaryNotice = watchInstall && step !== 'dictionary' && dictionary && (
    <div className="setup-downloads">
      <strong>{dictionary.recommended?.name ?? t('onboarding.steps.dictionary')}</strong>
      <span role="status">{dictionary.error || dictionaryError ? t('onboarding.dictionaryError') : dictionaryStatus}</span>
      {(dictionary.error || dictionaryError) && <button disabled={busy} type="button"
        onClick={() => void run(() => saveProgress('dictionary'))}>{t('onboarding.steps.dictionary')}</button>}
    </div>
  );
  const navigation = <>
    <button type="button" className="setup-link" disabled={busy} onClick={pause}>{t('onboarding.pause')}</button>
    <div className="setup-nav-buttons">
      {index > 0 && <button type="button" disabled={busy || !loaded} onClick={() => void run(() => saveProgress(ONBOARDING_STEPS[index - 1]))}>{t('onboarding.back')}</button>}
      {step !== 'finish' && <button type="button" className="setup-link" disabled={busy || !loaded} onClick={() => void next(true)}>{t('onboarding.skip')}</button>}
      <button type="button" className="setup-primary" disabled={busy || !loaded || !ready} onClick={() => void next()}>
        {t(busy ? 'onboarding.saving' : step === 'finish' ? 'onboarding.finish' : 'onboarding.next')}
      </button>
    </div>
  </>;
  if (guidedStep) return (<>
    <aside className="setup-guide" aria-label={t('onboarding.title')}>
      <WorkspaceIcon name={guidedStep === 'game' ? 'play' : 'capture'} />
      <div className="setup-guide-copy">
        <strong>{t('onboarding.stepOf', {step: index + 1, total: ONBOARDING_STEPS.length})} · {t('onboarding.steps.' + guidedStep)}</strong>
        <span id="setup-guide-hint">{t(guidedStep === 'game' ? (hasGame ? 'onboarding.gameReady' : 'onboarding.gameGuide')
          : canTextHook ? 'onboarding.captureGuide' : 'onboarding.captureOcrGuide')}</span>
      </div>
      {navigation}
      {error && <span role="alert">{t('onboarding.error')}</span>}
    </aside>
    {downloads}{dictionaryNotice}
  </>);

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
          {downloads}{dictionaryNotice}
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
                  {dictionary?.recommended && !dictionary.recommendedInstalled && <button type="button" className="setup-primary" data-setup-target={!dictionaryReady && !dictionary.busy || undefined} disabled={busy || dictionary.busy} onClick={() => void dictionaryAction('install')}>
                    {t(dictionary.busy ? 'onboarding.installing' : 'onboarding.installDictionary', { name: dictionary.recommended.name })}
                  </button>}
                  <button type="button" disabled={busy || dictionary?.busy} onClick={() => void dictionaryAction('open')}>{t('onboarding.dictionarySettings')}</button>
                </div>
                <p className="setup-status" role="status">{readerChanging ? t('onboarding.switching') : dictionaryStatus}</p>
                {(dictionaryError || dictionaryIssue) && <p className="setup-error" role="alert">{t('onboarding.dictionaryError')}{dictionaryIssue && <span>{dictionaryIssue}</span>}</p>}
              </>}
              {step === 'anki' && <div className="setup-actions">
                <button type="button" className="setup-primary" data-setup-target="true" disabled={busy}
                  onClick={() => void run(async () => { await invokeIpc('settings.mining.recommendedAnki'); })}>{t('onboarding.setUpAnki')}</button>
                <button type="button" disabled={busy} onClick={() => void run(async () => {
                  await invokeIpc('open-external', 'https://ankiweb.net/shared/info/2055492159');
                })}>{t('onboarding.getAnkiConnect')}</button>
              </div>}
              {step === 'finish' && <>
                <ol className="setup-instructions"><li>{t('onboarding.tourHome')}</li><li>{t('onboarding.tourLookup')}</li><li>{t('onboarding.tourText')}</li></ol>
                <button type="button" className="setup-link" disabled={busy} onClick={() => void run(async () => { await invokeIpc('openTexthooker'); })}>{t('onboarding.openText')}</button>
              </>}
            </>}
            {error && <p className="setup-error" role="alert">{t('onboarding.error')}</p>}
          </div>
          <footer className="setup-footer">{navigation}</footer>
        </div>
      </div>
    </div>
  );
}
