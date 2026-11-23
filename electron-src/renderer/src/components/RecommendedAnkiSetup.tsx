import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import { invokeIpc, onIpc } from '../lib/ipc';
import './NativeDialogs.css';

type Fields = [string, string][];
type Preset = { id: string; name: string; gsmFields: Fields; yomitanFields: Fields };
type SetupResult = { importPending?: boolean; model?: string; profile?: string; yomitanError?: string; yomitanFields?: Fields };
type Status = { key: string; params?: Record<string, string> };

export function RecommendedAnkiSetup() {
    const t = useTranslation();
    const heading = t('nativeDialogs.anki.title');
    const [presets, setPresets] = useState<Preset[]>([]);
    const [selected, setSelected] = useState('lapis');
    const [deck, setDeck] = useState('GSM');
    const [decks, setDecks] = useState<string[]>([]);
    const [yomitan, setYomitan] = useState(true);
    const [tab, setTab] = useState<'gsm' | 'yomitan'>('gsm');
    const [actual, setActual] = useState<Fields>();
    const [phase, setPhase] = useState('install');
    const [busy, setBusy] = useState(false);
    const inFlight = useRef(false);
    const [status, setStatus] = useState<Status>({ key: 'prompt' });
    const preset = presets.find((item) => item.id === selected);
    const mapping = actual ?? preset?.yomitanFields ?? [];
    const reportError = (error: unknown) => setStatus({ key: 'error', params: { error: String(error) } });

    useEffect(() => {
        let live = true;
        void invokeIpc<Preset[]>('recommendedAnki.read').then((data) => { if (live) setPresets(data); })
            .catch((error) => { if (live) setStatus({ key: 'error', params: { error: String(error) } }); });
        return () => { live = false; };
    }, []);
    useEffect(() => { void invokeIpc('recommendedAnki.title', heading).catch(() => {}); }, [heading]);
    useEffect(() => onIpc('recommendedAnki.configuringYomitan', () =>
        setStatus({ key: 'configuringYomitan' })), []);

    async function run(work: () => Promise<void>) {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        try { await work(); }
        catch (error) { reportError(error); }
        finally {
            inFlight.current = false;
            setBusy(false);
        }
    }

    const close = () => {
        if (!inFlight.current) void invokeIpc('recommendedAnki.close').catch(reportError);
    };

    const check = () => run(async () => {
        setStatus({ key: 'checking' });
        setDecks(await invokeIpc<string[]>('recommendedAnki.check'));
        setStatus({ key: 'connected' });
    });

    const install = () => run(async () => {
        setStatus({ key: phase === 'finish' ? 'checkingImport' : 'preparing' });
        const result = await invokeIpc<SetupResult>('recommendedAnki.install', { preset: selected, deck, yomitan });
        if (result.importPending) {
            setPhase('finish');
            setStatus({ key: 'pending' });
            return;
        }
        setPhase('again');
        setActual(result.yomitanFields);
        if (result.yomitanError) setStatus({ key: 'yomitanError', params: { error: result.yomitanError } });
        else if (result.profile) setStatus({ key: 'complete', params: { profile: result.profile } });
        else setStatus({ key: 'saved', params: { model: result.model ?? '' } });
    });

    return (
        <main className="native-dialog recommended-anki" onKeyDown={(e) => {
            if (e.key === 'Escape') close();
        }}>
            <p>{t('nativeDialogs.anki.instructions')}</p>
            <div className="recommended-anki-form">
                <label htmlFor="anki-preset">{t('nativeDialogs.anki.cardType')}</label>
                <select id="anki-preset" value={selected} disabled={busy || !preset} onChange={(e) => {
                    const id = e.target.value;
                    void run(async () => {
                        await invokeIpc('recommendedAnki.reset');
                        setSelected(id);
                        setActual(undefined);
                        setPhase('install');
                    });
                }}>
                    {presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <label htmlFor="anki-deck">{t('nativeDialogs.anki.deck')}</label>
                <div className="recommended-anki-deck">
                    <input id="anki-deck" type="text" list="recommended-decks" value={deck} disabled={busy} onChange={(e) => setDeck(e.target.value)} />
                    <datalist id="recommended-decks">{decks.map((name) => <option key={name} value={name} />)}</datalist>
                    <button type="button" disabled={busy} onClick={() => void check()}>{t('nativeDialogs.anki.check')}</button>
                </div>
            </div>
            <p>
                {t(`nativeDialogs.anki.description.${selected}`)}{' '}
                <button type="button" className="native-dialog-link" onClick={() => void invokeIpc('recommendedAnki.guide', selected).catch(reportError)}>
                    {t('nativeDialogs.anki.guide')}
                </button>
            </p>
            <label className="recommended-anki-check">
                <input type="checkbox" checked={yomitan} disabled={busy} onChange={(e) => setYomitan(e.target.checked)} />
                {t('nativeDialogs.anki.configure')}
            </label>
            <p>{t('nativeDialogs.anki.details')}</p>
            <p>{t('nativeDialogs.anki.yomitanDetails')}</p>
            <div className="recommended-anki-tabs" role="tablist">
                {(['gsm', 'yomitan'] as const).map((id) => <button key={id} id={`recommended-anki-${id}`} type="button" role="tab"
                    aria-controls="recommended-anki-table" aria-selected={tab === id} onClick={() => setTab(id)}>{t(`nativeDialogs.anki.tabs.${id}`)}</button>)}
            </div>
            <div className="recommended-anki-table" id="recommended-anki-table" role="tabpanel" aria-labelledby={`recommended-anki-${tab}`}>
                <table>
                    <thead><tr>
                        <th>{t(tab === 'gsm' ? 'nativeDialogs.anki.gsmSetting' : 'nativeDialogs.anki.ankiField')}</th>
                        <th>{t(tab === 'gsm' ? 'nativeDialogs.anki.ankiField' : 'nativeDialogs.anki.yomitanValue')}</th>
                    </tr></thead>
                    <tbody>{(tab === 'gsm' ? preset?.gsmFields ?? [] : mapping).map(([name, value]) => (
                        <tr key={name}><td>{tab === 'gsm' ? t(`nativeDialogs.anki.fields.${name}`) : name}</td><td>{value}</td></tr>
                    ))}</tbody>
                </table>
            </div>
            <button type="button" disabled={!mapping.length} onClick={() => {
                void invokeIpc('recommendedAnki.copy', mapping.map(([name, value]) => `${name}\t${value}`).join('\n'))
                    .then(() => setStatus({ key: 'copied' })).catch(reportError);
            }}>{t('nativeDialogs.anki.copy')}</button>
            <div role="status">{t(`nativeDialogs.anki.status.${status.key}`, status.params)}</div>
            <footer>
                <button type="button" disabled={busy || !preset} onClick={() => void install()}>{t(`nativeDialogs.anki.${phase}`)}</button>
                <button type="button" disabled={busy} onClick={close}>{t('nativeDialogs.close')}</button>
            </footer>
        </main>
    );
}
