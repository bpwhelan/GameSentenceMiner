import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { once: vi.fn(), getPath: () => '' }, clipboard: {} }));
vi.mock('./reader_dictionary', () => ({ lookupReaderDictionary: vi.fn(), openReaderDictionary: vi.fn() }));
import { readerRoute } from './reader';
describe('reader request boundary', () => {
  it('only permits named textfeed operations', () => {
    expect(readerRoute('select')).toEqual({ path: '/update_checkboxes', method: 'post' });
    for (const value of ['__proto__', 'constructor', '/delete-everything', 'https://example.com', {}, null]) expect(() => readerRoute(value)).toThrow();
  });
});
