import { useEffect, useRef, useState } from 'react';
import {
  NOTIFICATION_CATEGORY_IDS, NOTIFICATION_MODES, NOTIFICATION_SOUNDS,
  normalizeNotificationPreferences,
  type NotificationCategory, type NotificationEventPreference, type NotificationPreferences,
} from '../../../../shared/notifications';
import { useTranslation } from '../../i18n';
import { invokeIpc } from '../../lib/ipc';
import './NotificationSettings.css';

export function NotificationSettings({ active }: { active: boolean }) {
  const t = useTranslation();
  const [preferences, setPreferences] = useState(() => normalizeNotificationPreferences(null));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const current = useRef(preferences);
  const revision = useRef(0);
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const requestRevision = revision.current;
    void saveQueue.current.then(() => invokeIpc<{ preferences: unknown }>('settings.notifications.get'))
      .then((snapshot) => {
        if (cancelled || revision.current !== requestRevision) return;
        current.current = normalizeNotificationPreferences(snapshot.preferences);
        setPreferences(current.current);
        setLoaded(true);
        setError('');
      }).catch(() => { if (!cancelled) setError('settings.notifications.loadError'); });
    return () => { cancelled = true; };
  }, [active, reload]);

  function save(next: NotificationPreferences) {
    current.current = next;
    setPreferences(next);
    setSaving(true);
    setError('');
    const requestRevision = ++revision.current;
    // Keep quick selections and volume changes in order, including while hidden.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await invokeIpc('settings.notifications.save', next);
        if (mounted.current && revision.current === requestRevision) {
          setError((currentError) => currentError === 'settings.notifications.saveError' ? '' : currentError);
        }
      } catch {
        if (mounted.current && revision.current === requestRevision) setError('settings.notifications.saveError');
      } finally {
        if (mounted.current && revision.current === requestRevision) setSaving(false);
      }
    });
  }

  function changeCategory(category: NotificationCategory, patch: Partial<NotificationEventPreference>) {
    save({ ...current.current, categories: { ...current.current.categories, [category]: { ...current.current.categories[category], ...patch } } });
  }

  async function preview(category: NotificationCategory) {
    setPreviewing(true);
    setError('');
    try {
      await invokeIpc('settings.notifications.preview', { sound: current.current.categories[category].sound, volume: current.current.volume });
    } catch {
      if (mounted.current) setError((currentError) => currentError || 'settings.notifications.previewError');
    } finally {
      if (mounted.current) setPreviewing(false);
    }
  }

  return <div className="notification-settings">
    <p className="ws-lead">{t('settings.notifications.description')}</p>
    {error && <div className="ws-notice is-error" role="alert">
      {t(error)}{' '}
      {error !== 'settings.notifications.previewError' && <button type="button" onClick={() => error === 'settings.notifications.saveError' ? save(current.current) : setReload((value) => value + 1)}>
        {t('settings.notifications.retry')}
      </button>}
    </div>}
    {!loaded ? <p>{t('settings.notifications.loading')}</p> : <>
      <div className="notification-volume ws-card">
        <label htmlFor="notification-volume">{t('settings.notifications.volume')}</label>
        <input id="notification-volume" type="range" min="0" max="100" step="1" value={preferences.volume}
          onChange={(event) => save({ ...current.current, volume: Number(event.currentTarget.value) })} />
        <output htmlFor="notification-volume">{t('settings.notifications.volumeValue', { volume: preferences.volume })}</output>
        <button type="button" onClick={() => save(normalizeNotificationPreferences(null))}>{t('settings.notifications.quietDefaults')}</button>
      </div>
      <p className="notification-settings-hint">{t('settings.notifications.globalHint')}</p>
      <div className="notification-events">
        {NOTIFICATION_CATEGORY_IDS.map((category) => {
          const preference = preferences.categories[category];
          const label = t(`settings.notifications.categories.${category}`);
          const usesSound = preference.mode === 'sound' || preference.mode === 'both';
          return <div className="notification-event ws-card" key={category}>
            <div className="notification-event-name"><strong>{label}</strong>
              <span>{t(`settings.notifications.categoryDescriptions.${category}`)}</span>
            </div>
            <label htmlFor={`notification-mode-${category}`}>
              <span>{t('settings.notifications.delivery')}</span>
              <select id={`notification-mode-${category}`} aria-label={t('settings.notifications.deliveryFor', { event: label })}
                value={preference.mode} onChange={(change) => changeCategory(category, { mode: change.currentTarget.value as NotificationEventPreference['mode'] })}>
                {NOTIFICATION_MODES.map((mode) => <option key={mode} value={mode}>{t(`settings.notifications.modes.${mode}`)}</option>)}
              </select>
            </label>
            <label htmlFor={`notification-sound-${category}`}>
              <span>{t('settings.notifications.sound')}</span>
              <select id={`notification-sound-${category}`} aria-label={t('settings.notifications.soundFor', { event: label })}
                disabled={!usesSound} value={preference.sound}
                onChange={(change) => {
                  changeCategory(category, { sound: change.currentTarget.value as NotificationEventPreference['sound'] });
                  void preview(category);
                }}>
                {NOTIFICATION_SOUNDS.filter((sound) => sound !== 'pause-resume' || category === 'pauseResume')
                  .map((sound) => <option key={sound} value={sound}>{t(`settings.notifications.sounds.${sound}`)}</option>)}
              </select>
            </label>
            <button type="button" className="notification-preview" disabled={!usesSound || preferences.volume === 0 || previewing}
              aria-label={t('settings.notifications.previewFor', { event: label })} onClick={() => void preview(category)}>
              {t('settings.notifications.preview')}
            </button>
          </div>;
        })}
      </div>
      <p role="status">{t(saving ? 'settings.notifications.saving' : 'settings.notifications.autoSave')}</p>
    </>}
  </div>;
}
