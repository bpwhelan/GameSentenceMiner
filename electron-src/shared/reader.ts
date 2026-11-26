/** Portable desktop reader contract. No Electron or DOM dependencies. */
export type ReaderScanModifier = 'shift' | 'ctrl' | 'alt' | 'meta' | 'none';

export interface ReaderLine {
  id: string;
  sessionId: string;
  text: string;
  sequence: number;
  revision: number;
  state: 'provisional' | 'frozen' | 'expired';
  source: string;
  scene: string;
  capturedAt: string;
  excludedFromStats: boolean;
  timestamp?: number;
  rowid?: number;
  translation?: string;
}

export interface ReaderHistoryCursor {
  beforeTimestamp: number;
  beforeRowid: number;
}

export interface ReaderHistoryLine {
  id: string;
  text: string;
  scene: string;
  capturedAt: string;
  timestamp: number;
  rowid: number;
  translation?: string;
}

export interface ReaderHistoryPage {
  lines: ReaderHistoryLine[];
  hasMore: boolean;
  nextCursor: ReaderHistoryCursor | null;
}

export interface ReaderHistoryRequest {
  scene: string;
  limit?: number;
  beforeTimestamp?: number;
  beforeRowid?: number;
  query?: string;
}

export interface ReaderState {
  sessionId: string;
  lines: ReaderLine[];
}

export interface ReaderConnection {
  baseUrl: string;
  websocketUrl: string;
  storageKey: string;
}

export type ReaderAction = 'state' | 'select' | 'audio' | 'screenshot' | 'translate' | 'saveClip' | 'createMedia' | 'pauseIntake' | 'stats';

export interface ReaderDictionaryEntry {
  term: string;
  reading: string;
  dictionary: string;
  definitions: string[];
}

export interface ReaderDictionaryResult {
  entries: ReaderDictionaryEntry[];
  matchedLength: number;
  reader: string;
}

export interface ReaderDictionaryTransfer {
  name: string;
  phase: 'reading' | 'exporting' | 'importing' | 'failed';
  records: number;
}
