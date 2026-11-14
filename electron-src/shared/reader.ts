/** Portable desktop reader contract. No Electron or DOM dependencies. */
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
  phase: 'reading' | 'importing' | 'failed';
  records: number;
}
