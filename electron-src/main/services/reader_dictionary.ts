import { createRequire } from 'node:module';
import { app, BrowserWindow, session, shell, type Extension, type Session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getOverlayDataPath } from '../overlay_data_dir.js';
import { getOverlayResourcesPath, getResourcesDir, isDev } from '../util.js';
import type { ReaderDictionaryEntry, ReaderDictionaryResult } from '../../shared/reader.js';

const SHARED_DICTIONARY = Symbol.for('gsm.reader.dictionary');
interface DictionaryLease { reader: string; extensionId: string; engineWindow?: BrowserWindow; }
const shared = globalThis as typeof globalThis & { [SHARED_DICTIONARY]?: DictionaryLease };
let page: BrowserWindow | null = null;
let dictionaryWindow: BrowserWindow | null = null;
let preparing: Promise<{ reader: string; extension: Extension; page: BrowserWindow }> | null = null;
let readerSession: Session | null = null;

export function dictionaryText(value: unknown, depth = 0): string {
  if (depth > 12) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => dictionaryText(item, depth + 1)).join('');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (item.tag === 'br') return '\n';
  const content = dictionaryText(item.content ?? item.text ?? item.value ?? '', depth + 1);
  return ['li', 'div', 'p'].includes(String(item.tag)) ? `${content}\n` : content;
}

export function normalizeDictionaryResult(value: unknown, reader: string): ReaderDictionaryResult {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {};
  const source = raw.dictionaryEntries ?? raw.entries ?? raw.results ?? raw.result?.entries ?? [];
  const entries: ReaderDictionaryEntry[] = [];
  for (const item of Array.isArray(source) ? source.slice(0, 30) : []) {
    if (!item || typeof item !== 'object') continue;
    const head = item.headwords?.[0] ?? item.term ?? item;
    const definitions = item.definitions ?? item.term?.glossaries ?? item.glossary ?? item.senses ?? [];
    const grouped = Array.isArray(definitions) ? definitions : [definitions];
    for (const definition of grouped) {
      let strings = definition?.entries ?? definition?.glossary ?? definition;
      if (reader === 'hachidori' && typeof strings === 'string') { try { strings = JSON.parse(strings); } catch { /* Plain text glossary. */ } }
      const content = (Array.isArray(strings) ? strings : [strings]).map(value => dictionaryText(value).trim()).filter(Boolean);
      if (!content.length) continue;
      entries.push({ term: String(head.term ?? head.expression ?? head.spelling ?? item.expression ?? ''), reading: String(head.reading ?? item.reading ?? ''), dictionary: String(definition?.dictionary ?? item.dictionary ?? item.dictionaryName ?? ''), definitions: content.slice(0, 20) });
    }
  }
  return { reader, entries: entries.slice(0, 30), matchedLength: Number(raw.originalTextLength ?? raw.matchedLength ?? raw.results?.[0]?.matched?.length ?? 0) };
}

function selection(): string {
  try { return JSON.parse(fs.readFileSync(path.join(getOverlayDataPath(), 'settings.json'), 'utf8')).dictionaryReaderSelection === 'hachidori' ? 'hachidori' : 'yomitan'; }
  catch { return 'yomitan'; }
}

function extensionSource(reader: string, resourceRoot: string, existing?: Extension): string {
  if (existing) return existing.path;
  const bundled = path.join(resourceRoot, reader);
  const nativeWindows = process.env.GSM_NATIVE_SERVICE && process.platform === 'win32' && process.env.GSM_PORTABLE_DICTIONARIES !== '1';
  const profileYomitan = Boolean(process.env.GSM_PROFILE_DIR) && reader === 'yomitan' && !nativeWindows;
  if (process.platform !== 'linux' && !profileYomitan) return bundled;
  // Match the overlay's stable extension location and revision marker. Its
  // dictionaries live in the session database, outside this code-only copy.
  const root = path.join(getOverlayDataPath(), 'extensions'), target = path.join(root, reader);
  const versionsFile = path.join(root, 'versions.json');
  let versions: Record<string, string> = {};
  try { versions = JSON.parse(fs.readFileSync(versionsFile, 'utf8')); } catch {}
  const moduleRoot = path.join(resourceRoot, ...(isDev || process.env.GSM_NATIVE_SERVICE ? [] : ['app.asar']));
  let revision: string;
  if (reader === 'yomitan') revision = createRequire(import.meta.url)(path.join(moduleRoot, 'extension_revision.js')).getExtensionContentRevision(bundled);
  else {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundled, 'manifest.json'), 'utf8'));
    const source = JSON.parse(fs.readFileSync(path.join(bundled, 'SOURCE.json'), 'utf8'));
    const fingerprint = [source.commit, source.gsmIntegration?.sha256].filter(Boolean).join('.');
    revision = fingerprint ? `${manifest.version}+${fingerprint}` : String(manifest.version);
  }
  if (versions[reader] !== revision || !fs.existsSync(path.join(target, 'manifest.json'))) {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(bundled, target, { recursive: true, force: true });
    fs.writeFileSync(versionsFile, JSON.stringify({ ...versions, [reader]: revision }, null, 2));
  }
  if (profileYomitan && fs.existsSync(path.join(target, 'manifest_static.json'))) fs.copyFileSync(path.join(target, 'manifest_static.json'), path.join(target, 'manifest.json'));
  return target;
}

export function homeReaderSession(): Session {
  readerSession ??= session.fromPath(getOverlayDataPath());
  const native = readerSession as Session & { configureDictionaryBootstrap?: (directories: string[], active: string) => void };
  if (native.configureDictionaryBootstrap) {
    const root = isDev ? path.join(getResourcesDir(), 'GSM_Overlay') : getOverlayResourcesPath();
    native.configureDictionaryBootstrap(['yomitan', 'hachidori', 'jiten.reader'].map(reader => reader==='jiten.reader'?path.join(root,reader):extensionSource(reader, root)), selection());
  }
  return readerSession;
}

export async function attachHomeDictionary(contents: Electron.WebContents): Promise<void> {
  const window = BrowserWindow.fromWebContents(contents);
  if (!window) throw new Error('Reading window is closed.');
  const { extension } = process.env.GSM_NATIVE_SERVICE && process.platform==='win32' && process.env.GSM_PORTABLE_DICTIONARIES!=='1'
    ? await loadSelectedExtension() : await prepare();
  const host = (readerSession as Session & {host?: {attachReader: (window: BrowserWindow, id: string) => Promise<void>}}).host;
  if (host) await host.attachReader(window, extension.id);
}

async function loadSelectedExtension(): Promise<{reader:string;extension:Extension}> {
  const reader=selection();
  readerSession ??= session.fromPath(getOverlayDataPath());
  const existing=readerSession.extensions.getAllExtensions().find(extension=>extension.name.toLowerCase().includes(reader));
  const resourceRoot=isDev?path.join(getResourcesDir(),'GSM_Overlay'):getOverlayResourcesPath();
  const extension=existing??await readerSession.extensions.loadExtension(extensionSource(reader,resourceRoot),{allowFileAccess:true});
  const old=shared[SHARED_DICTIONARY];
  shared[SHARED_DICTIONARY]={reader,extensionId:extension.id,engineWindow:old?.extensionId===extension.id?old.engineWindow:undefined};
  return {reader,extension};
}

export async function preserveHomePreferences(window: BrowserWindow): Promise<void> {
  if (!process.env.GSM_NATIVE_SERVICE) return;
  const url = `${process.platform === 'win32' ? 'http://gsm.localhost' : 'gsm://localhost'}/renderer/__gsm_migration__.html`;
  await window.loadURL(url);
  if (await window.webContents.executeJavaScript('localStorage.getItem("gsm-shared-reader-profile-v1")')) return;
  const previous = new BrowserWindow({show:false,skipTaskbar:true,webPreferences:{session:session.defaultSession}});
  try {
    await previous.loadURL(url);
    const saved = await previous.webContents.executeJavaScript('Object.fromEntries(Object.entries(localStorage))');
    await window.webContents.executeJavaScript(`(() => {for(const [key,value] of Object.entries(${JSON.stringify(saved)}))if(localStorage.getItem(key)===null)localStorage.setItem(key,value);localStorage.setItem('gsm-shared-reader-profile-v1','1');})()`);
  } finally { previous.destroy(); }
}

async function prepare(): Promise<{ reader: string; extension: Extension; page: BrowserWindow }> {
  if (preparing) return preparing;
  preparing = (async () => {
    const reader = selection();
    readerSession ??= session.fromPath(getOverlayDataPath());
    const api = readerSession.extensions;
    const existing = api.getAllExtensions().find(extension => extension.name.toLowerCase().includes(reader));
    const resourceRoot = isDev ? path.join(getResourcesDir(), 'GSM_Overlay') : getOverlayResourcesPath();
    const source = extensionSource(reader, resourceRoot, existing);
    if (!fs.existsSync(path.join(source, 'manifest.json'))) throw new Error('The dictionary reader is not installed. Open Overlay settings to install it.');
    const extension = existing ?? await api.loadExtension(source, { allowFileAccess: true });
    const old = shared[SHARED_DICTIONARY];
    shared[SHARED_DICTIONARY] = { reader, extensionId: extension.id, engineWindow: old?.extensionId === extension.id ? old.engineWindow : undefined };
    if (!page || page.isDestroyed() || !page.webContents.getURL().startsWith(`chrome-extension://${extension.id}/`)) {
      page?.destroy();
      page = new BrowserWindow({ show: false, skipTaskbar: true, width: 1, height: 1, webPreferences: { session: readerSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await page.loadURL(`chrome-extension://${extension.id}/${reader === 'yomitan' ? 'templates-display.html' : 'settings.html'}`);
    }
    if (reader === 'hachidori') {
      const { ensureHachidoriEngine } = createRequire(import.meta.url)(path.join(resourceRoot, ...(isDev || process.env.GSM_NATIVE_SERVICE ? [] : ['app.asar']), 'shared_dictionary_engine.cjs'));
      shared[SHARED_DICTIONARY]!.engineWindow = await ensureHachidoriEngine(BrowserWindow, readerSession, extension.id) ?? undefined;
    }
    return { reader, extension, page };
  })();
  try { return await preparing; } finally { preparing = null; }
}

export async function lookupReaderDictionary(value: unknown): Promise<ReaderDictionaryResult> {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Select up to 200 characters to look up.');
  const { reader, page: host } = await prepare();
  const argument = JSON.stringify(value);
  const script = reader === 'yomitan' ? `(async () => {
    const {API} = await import('./js/comm/api.js');
    const {WebExtension} = await import('./js/extension/web-extension.js');
    const api = new API(new WebExtension());
    const options = await api.optionsGetFull();
    return api.termsFind(${argument}, {}, {index: options.profileCurrent});
  })()` : `chrome.runtime.sendMessage({target:'hoshidicts-offscreen',type:'hd_lookup',text:${argument}})`;
  for (let attempt = 0; ; attempt++) {
    const result = await host.webContents.executeJavaScript(script);
    // The engine briefly commits its initial state during a cold start. Avoid
    // turning that normal startup into a failed first lookup.
    if (reader === 'hachidori' && /busy mutating/i.test(String(result?.error)) && attempt < 20) {
      await new Promise(resolve => setTimeout(resolve, 200)); continue;
    }
    if (result?.error) throw new Error(String(result.error));
    return normalizeDictionaryResult(result, reader);
  }
}

export async function openReaderDictionary(value: unknown): Promise<void> {
  const input = value as { text?: unknown; context?: unknown } | null;
  if (!input || typeof input.text !== 'string' || input.text.length > 200 || typeof input.context !== 'string' || input.context.length > 100000) throw new Error('Invalid dictionary context.');
  const { extension, reader } = await prepare();
  const url = new URL(`chrome-extension://${extension.id}/search.html`);
  url.searchParams.set('query', input.text);
  url.searchParams.set('full', input.context);
  url.searchParams.set('offset', String(Math.max(0, input.context.indexOf(input.text))));
  if (!dictionaryWindow || dictionaryWindow.isDestroyed()) {
    dictionaryWindow = new BrowserWindow({ width: 700, height: 720, minWidth: 420, minHeight: 320, show: false, title: 'GSM · Dictionary', webPreferences: { session: readerSession!, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    dictionaryWindow.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });
    dictionaryWindow.webContents.on('will-navigate', (event, target) => { if (!target.startsWith(`chrome-extension://${extension.id}/`)) event.preventDefault(); });
  }
  await dictionaryWindow.loadURL(url.toString()); dictionaryWindow.show(); dictionaryWindow.focus();
  if (reader === 'hachidori') {
    if (process.env.GSM_NATIVE_SERVICE) {
      await dictionaryWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const id = crypto.randomUUID(); let frame;
        const listener = event => {
          if (event.source !== frame?.contentWindow || event.data?.type !== 'gsm.native-search.result' || event.data.id !== id) return;
          clearInterval(interval); clearTimeout(timeout); window.removeEventListener('message', listener);
          event.data.error ? reject(Error(event.data.error)) : resolve();
        };
        window.addEventListener('message', listener);
        const interval = setInterval(() => {
          frame = document.querySelector('iframe');
          if (!frame?.contentWindow) return;
          frame.contentWindow.postMessage({type:'gsm.native-search', id, text:${JSON.stringify(input.context)}, offset:${Math.max(0, input.context.indexOf(input.text))}}, '*');
        }, 100);
        const timeout = setTimeout(() => { clearInterval(interval); window.removeEventListener('message', listener); reject(Error('Dictionary search did not become ready.')); }, 35000);
      })`);
      return;
    }
    // Hachidori's search page doesn't consume Yomitan's query URL parameters.
    // Populate its public search UI in the sandboxed reader frame instead.
    const searchWindow = dictionaryWindow;
    let frame = searchWindow.webContents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(`chrome-extension://${extension.id}/search-frame.html`));
    // Its search frame is created after the extension finishes loading options.
    for (let attempt = 0; !frame && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (searchWindow.isDestroyed()) return;
      frame = searchWindow.webContents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(`chrome-extension://${extension.id}/search-frame.html`));
    }
    if (!frame) throw new Error('Dictionary search is not ready.');
    await frame.executeJavaScript(`(async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const input = document.querySelector('input[type="text"], input[type="search"], textarea');
        const submit = document.querySelector('button[type="submit"]');
        if (input && submit && !submit.disabled) {
          input.value = ${JSON.stringify(input.context)};
          input.dispatchEvent(new Event('input', {bubbles:true})); submit.click();
          const query = document.getElementById('search-query');
          while (!query?.firstChild && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
          if (query?.firstChild) await globalThis.HDSearchHistory?.lookUp(query.firstChild, ${Math.max(0, input.context.indexOf(input.text))});
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Dictionary search did not become ready.');
    })()`);
  }
}

export function closeReaderDictionary(): void {
  page?.destroy(); page = null; dictionaryWindow?.destroy(); dictionaryWindow = null;
  const lease = shared[SHARED_DICTIONARY];
  if (lease?.engineWindow && !lease.engineWindow.isDestroyed()) lease.engineWindow.destroy();
  delete shared[SHARED_DICTIONARY];
}

app.once('will-quit', closeReaderDictionary);
