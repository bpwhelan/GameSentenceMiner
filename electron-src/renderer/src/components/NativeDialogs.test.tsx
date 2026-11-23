// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { FuriganaPreview } from './FuriganaPreview';
import { OcrAreaSelector } from './OcrAreaSelector';
import { RecommendedAnkiSetup } from './RecommendedAnkiSetup';

const invoke = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
    vi.stubGlobal('ResizeObserver', class {
        constructor(private update: ResizeObserverCallback) {}
        observe() { this.update([{ contentRect: { width: 1000, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
        disconnect() {}
    });
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke, on: () => () => {} } });
    invoke.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function render(component: ReactNode) {
    await act(async () => root.render(<I18nProvider>{component}</I18nProvider>));
}

async function click(text: string) {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(button, text).toBeDefined();
    await act(async () => button?.click());
}

function areaFixture(single: boolean) {
    invoke.mockImplementation(async (channel) => {
        if (channel === 'ocrArea.options') return { obs: true, single, overlay: false, monitorOnly: false, live: !single, help: false };
        if (channel === 'ocrArea.capture') return {
            image: '/frame.jpg', width: 1000, height: 500,
            rects: [{ xywh: [0.1, 0.2, 0.3, 0.4], excluded: true }],
        };
        if (channel === 'ocrArea.refresh') return '/updated.jpg';
        return null;
    });
}

async function dragArea() {
    const stage = container.querySelector('.ocr-selector-stage')!;
    Object.defineProperty(stage, 'setPointerCapture', { value: () => {} });
    vi.spyOn(container.querySelector('.ocr-selector-image')!, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(50, 34, 1000, 500));
    const pointer = (type: string, x: number, y: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ctrlKey: true });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        stage.dispatchEvent(event);
    };
    await act(async () => {
        pointer('pointerdown', 750, 384);
        pointer('pointermove', 550, 184);
        pointer('pointerup', 550, 184);
    });
}

const secondary = expect.objectContaining({ xywh: [0.5, 0.3, expect.closeTo(0.2), expect.closeTo(0.4)], secondary: true });

it('debounces live OCR changes and preserves undo and redo through Save & Quit', async () => {
    vi.useFakeTimers();
    areaFixture(false);
    await render(<OcrAreaSelector />);
    await dragArea();
    expect(invoke).not.toHaveBeenCalledWith('ocrArea.save', expect.anything());
    await act(async () => vi.advanceTimersByTime(300));
    expect(invoke).toHaveBeenCalledWith('ocrArea.save', { rects: [expect.objectContaining({ excluded: true }), secondary] });
    await click('↶ Undo');
    await act(async () => vi.advanceTimersByTime(300));
    expect(invoke).toHaveBeenLastCalledWith('ocrArea.save', { rects: [expect.objectContaining({ excluded: true })] });
    await click('↷ Redo');
    await click('💾 Save & Quit');
    expect(invoke).toHaveBeenLastCalledWith('ocrArea.finish', { rects: [expect.objectContaining({ excluded: true }), secondary] });
});

it('refreshes the OBS image without changing any OCR areas', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Image', class {
        src = '';
        async decode() {}
    });
    areaFixture(false);
    await render(<OcrAreaSelector />);
    await click('🔄 Auto-Refresh');
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.querySelector('.ocr-selector-image img')?.getAttribute('src')).toBe('/updated.jpg');
    expect(container.querySelectorAll('.ocr-selector-box')).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith('ocrArea.save', expect.anything());
});

it('submits only the new box in Add OCR Area mode', async () => {
    areaFixture(true);
    await render(<OcrAreaSelector />);
    await dragArea();
    expect(invoke).toHaveBeenLastCalledWith('ocrArea.finish', { rects: [secondary] });
});

it('cycles furigana engines and accepts zero as a valid sensitivity', async () => {
    invoke.mockImplementation(async (channel) => {
        if (channel === 'ocrPreview.read') return { image: '/sample.png', width: 800, height: 600, source: 'Game', sensitivity: 0 };
        if (channel === 'ocrPreview.detect') return [[[0, 10, 20, 40]], [[4, 10, 24, 40]], []];
        return null;
    });
    await render(<FuriganaPreview />);
    expect(container.querySelector('rect[stroke="magenta"]')).toBeTruthy();
    await click('Switch View (Unified)');
    expect(container.querySelectorAll('rect[stroke="green"]')).toHaveLength(1);
    expect(container.querySelector('rect[stroke="blue"]')).toBeFalsy();
    await click('OK');
    expect(invoke).toHaveBeenLastCalledWith('ocrPreview.resolve', 0);
});

it('waits for the Anki import and copies the verified installed fields', async () => {
    let installations = 0;
    invoke.mockImplementation(async (channel) => {
        if (channel === 'recommendedAnki.read') return [{ id: 'lapis', name: 'Lapis', gsmFields: [['word', 'Expression']], yomitanFields: [['Expression', '{expression}']] }];
        if (channel === 'recommendedAnki.install') return ++installations === 1
            ? { importPending: true }
            : { model: 'Lapis', yomitanFields: [['Expression', '{expression}'], ['Custom', '']], yomitanError: 'Overlay unavailable' };
        return null;
    });
    await render(<RecommendedAnkiSetup />);
    await click('Install and set up');
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Anki's import screen");
    await click('Finish setup');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('GSM settings saved.');
    await click('Copy Yomitan field table');
    expect(invoke).toHaveBeenLastCalledWith('recommendedAnki.copy', 'Expression\t{expression}\nCustom\t');
});
