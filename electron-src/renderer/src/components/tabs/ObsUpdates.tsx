import { useCallback, useEffect, useState } from 'react';
import { invokeIpc, onIpc } from '../../lib/ipc';
import { useTranslation } from '../../i18n';
import type { ObsRuntimeStatus } from '../../../../shared/obs_runtime';

export function ObsUpdates({ active }: { active: boolean }) {
  const t = useTranslation();
  const [status, setStatus] = useState<ObsRuntimeStatus | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const next = await invokeIpc<ObsRuntimeStatus>('obs.runtime.status');
    if (next && typeof next.supported === 'boolean') setStatus(next);
  }, []);
  useEffect(() => {
    if (active) void refresh().catch(cause => setError(String(cause)));
  }, [active, refresh]);
  useEffect(() => onIpc('obs.runtime.progress', (_event, payload) => {
    const next = payload as ObsRuntimeStatus;
    if (next && typeof next.supported === 'boolean') setStatus(next);
  }), []);

  async function run(name: 'check' | 'update' | 'rollback' | 'setAutomatic', value?: boolean) {
    if (action) return;
    setAction(name); setError('');
    try {
      const next = value === undefined
        ? await invokeIpc<ObsRuntimeStatus>(`obs.runtime.${name}`)
        : await invokeIpc<ObsRuntimeStatus>(`obs.runtime.${name}`, value);
      if (next) setStatus(next);
    } catch (cause) {
      setError(String(cause));
      await refresh().catch(() => {});
    } finally { setAction(null); }
  }

  const busy = Boolean(action || (status && !['idle', 'error'].includes(status.phase)));
  const enabled = Boolean(status?.supported && status.managed);
  const unknown = t('obsUpdates.unknown');
  return <div className="settings-update-panel" aria-label={t('obsUpdates.title')}>
    <h3>{t('obsUpdates.title')}</h3>
    <p className="muted">{t('obsUpdates.description')}</p>
    {status && !enabled ? <p>{t(status.supported ? 'obsUpdates.custom' : 'obsUpdates.unsupported')}</p> : <>
      <div className="update-version-list">
        <div className="update-version-row">
          <div>
            <div className="update-version-meta">{t('settings.updates.current', { version: status?.installedVersion ?? unknown })}</div>
            <div className="update-version-meta">{t(status?.pinnedVersion ? 'obsUpdates.pinned' : 'obsUpdates.target', { version: status?.targetVersion ?? unknown })}</div>
          </div>
          {status?.checkedAt && !status.updateAvailable && status.phase === 'idle' ? <span>{t('settings.updates.upToDate')}</span> : null}
        </div>
      </div>
      <div className="input-group">
        <label htmlFor="auto-update-obs">{t('obsUpdates.automatic')}</label>
        <input id="auto-update-obs" type="checkbox" checked={status?.automatic ?? false} disabled={!enabled || busy}
          onChange={event => void run('setAutomatic', event.target.checked)} />
      </div>
      <p className="update-version-meta">{t('obsUpdates.automaticHelp')}</p>
      <div className="input-group wrap settings-update-actions">
        <button type="button" className="secondary" disabled={!enabled || busy} onClick={() => void run('check')}>{t('settings.updates.checkForUpdates')}</button>
        <button type="button" className="secondary" disabled={!enabled || busy || Boolean(status?.checkedAt && !status.updateAvailable)} onClick={() => void run('update')}>
          {t(status?.updateAvailable && status.targetVersion ? 'obsUpdates.updateTo' : 'obsUpdates.update', { version: status?.targetVersion ?? '' })}
        </button>
        {status?.rollbackVersion ? <button type="button" className="secondary" disabled={!enabled || busy} onClick={() => void run('rollback')}>
          {t('obsUpdates.rollback', { version: status.rollbackVersion })}
        </button> : null}
      </div>
      <p className="update-version-meta">{t('obsUpdates.backupHelp')}</p>
    </>}
    {busy ? <div role="status">
      <p>{t(`obsUpdates.phase.${status?.phase && status.phase !== 'idle' ? status.phase : 'checking'}`)}</p>
      {status?.progress != null ? <progress max={1} value={status.progress} aria-label={t('obsUpdates.progress')} /> : null}
    </div> : null}
    {error || status?.error ? <p className="update-error-text" role="alert">{error || status?.error}</p> : null}
  </div>;
}
