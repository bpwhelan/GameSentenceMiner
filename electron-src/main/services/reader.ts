import { clipboard, ipcMain } from 'electron';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { gsmBackendUrl } from '../gsm_config.js';
import { getBaseDir } from '../data_dir.js';
import type { ReaderAction, ReaderConnection, ReaderDictionaryTransfer } from '../../shared/reader.js';
import { attachHomeDictionary, lookupReaderDictionary, openReaderDictionary } from './reader_dictionary.js';

const ROUTES: Record<ReaderAction, { path: string; method: 'get' | 'post' }> = {
  state: { path: '/get_ids', method: 'get' }, select: { path: '/update_checkboxes', method: 'post' },
  audio: { path: '/play-audio', method: 'post' }, screenshot: { path: '/get-screenshot', method: 'post' },
  translate: { path: '/translate-line', method: 'post' }, saveClip: { path: '/save-clip', method: 'post' },
  createMedia: { path: '/create-media', method: 'post' }, pauseIntake: { path: '/set_text_intake_paused', method: 'post' },
  stats: { path: '/set_stats_gathering_enabled', method: 'post' },
};

export function readerRoute(action: unknown): { path: string; method: 'get' | 'post' } {
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ROUTES, action)) throw new Error('Unknown reader action.');
  return ROUTES[action as ReaderAction];
}

export async function readerRequest(action: unknown, payload: unknown = {}): Promise<unknown> {
  const route = readerRoute(action);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 300000) throw new Error('Invalid reader request.');
  try {
    const response = await axios({ url: gsmBackendUrl(route.path), method: route.method, data: route.method === 'post' ? payload : undefined, timeout: action === 'translate' ? 90000 : 20000 });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) throw new Error(String(error.response?.data?.error || error.message));
    throw error;
  }
}

export async function readerConnection(): Promise<ReaderConnection> {
  const base = new URL(gsmBackendUrl('/'));
  const socket = new URL('/ws/texthooker', base); socket.protocol = 'ws:';
  try {
    const { data } = await axios.get(gsmBackendUrl('/get_websocket_port'), { timeout: 2500 });
    // The fallback listener is necessary when the optional HTTP/WS gateway is unavailable.
    const port = Number(data?.direct_port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) socket.port = String(port);
  } catch { /* The normal endpoint will reconnect while the backend is starting. */ }
  return { baseUrl: base.origin, websocketUrl: socket.toString(), storageKey: `gsm-reader-history-${createHash('sha256').update(getBaseDir()).digest('hex').slice(0, 16)}` };
}

export function registerReaderIPC(): void {
  ipcMain.handle('reader.attachDictionary', event => attachHomeDictionary(event.sender));
  ipcMain.handle('reader.dictionaryTransfers', () => {
    const state = (globalThis as Record<symbol, Map<string, ReaderDictionaryTransfer> | undefined>)[Symbol.for('gsm.dictionary.transfers')];
    return state ? [...state.values()] : [];
  });
  ipcMain.handle('reader.connection', () => readerConnection());
  ipcMain.handle('reader.history', () => ({ lines: [], hasMore: false, nextCursor: null }));
  ipcMain.handle('reader.request', (_event, action: unknown, payload: unknown) => readerRequest(action, payload));
  ipcMain.handle('reader.copy', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 1000000) throw new Error('Invalid clipboard text.');
    clipboard.writeText(text);
  });
  ipcMain.handle('reader.lookup', (_event, text: unknown) => lookupReaderDictionary(text));
  ipcMain.handle('reader.openDictionary', (_event, context: unknown) => openReaderDictionary(context));
}
