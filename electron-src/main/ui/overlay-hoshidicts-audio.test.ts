import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPopupDom as createDom,
  flushPromises as flushAsync,
  loadAudioModule,
  resetReaderTestState
} from "../../../GSM_Overlay/features/hoshidicts/test_helpers";

const CANDIDATE_ID = "a".repeat(64);
const SECOND_CANDIDATE_ID = "b".repeat(64);

const flushPromises = () => flushAsync(8);

function result(expression = "食べる", reading = "たべる") {
  return { term: { expression, reading } };
}

function audioProfile(
  sources: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {}
) {
  return {
    version: 1,
    enabled: true,
    autoPlay: false,
    volume: 100,
    ...overrides,
    sources
  };
}

function audioElement(overrides: Record<string, unknown> = {}) {
  return {
    addEventListener: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    removeAttribute: vi.fn(),
    src: "",
    volume: 1,
    ...overrides
  };
}

function createControllerHarness(options: Record<string, any> = {}) {
  const {
    appendButton = false,
    client = null,
    dom = createDom(),
    profile = {},
    render = true,
    sources = [{ id: "jisho", type: "jisho", url: "", voice: "" }],
    term = result(),
    ...controllerOptions
  } = options;
  const api = loadAudioModule(dom.window as unknown as Window);
  const button = dom.window.document.createElement("button");
  if (appendButton) {
    dom.window.document.body.appendChild(button);
  }
  const controller = api.createHoshidictsAudioController({
    window: dom.window,
    document: dom.window.document,
    client,
    audioPreferences: audioProfile(sources, profile),
    ...controllerOptions
  });
  if (render) {
    controller.setRenderedResults([{ button, result: term }]);
  }
  return { button, controller, dom, term };
}

afterEach(resetReaderTestState);

describe("Hoshidicts audio client", () => {
  it("uses only the local candidates and media endpoints", async () => {
    const dom = createDom();
    const api = loadAudioModule(dom.window as unknown as Window);
    const audioBlob = new Blob(["audio"], { type: "audio/mpeg" });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/candidates")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              index: 3,
              name: "Female",
              candidateId: CANDIDATE_ID,
              playbackUrl: "http://127.0.0.1:5050/audio.mp3"
            }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        blob: async () => audioBlob
      };
    });
    const client = api.createHoshidictsAudioClient({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchMock
    });

    await expect(client.getCandidates({
      term: "食べる",
      reading: "たべる",
      sourceId: "jpod101"
    })).resolves.toEqual([{
      index: 3,
      name: "Female",
      candidateId: CANDIDATE_ID,
      playbackUrl: "http://127.0.0.1:5050/audio.mp3"
    }]);
    await expect(client.getMedia({
      term: "食べる",
      reading: "たべる",
      sourceId: "jpod101",
      candidateIndex: 3,
      candidateId: CANDIDATE_ID
    })).resolves.toBe(audioBlob);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8123/api/hoshidicts/audio/candidates",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          term: "食べる",
          reading: "たべる",
          sourceId: "jpod101"
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8123/api/hoshidicts/audio/media",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          term: "食べる",
          reading: "たべる",
          sourceId: "jpod101",
          candidateIndex: 3,
          candidateId: CANDIDATE_ID
        })
      })
    );
  });

  it("preserves every candidate returned by the local audio API", async () => {
    const dom = createDom();
    const api = loadAudioModule(dom.window as unknown as Window);
    const candidates = Array.from({ length: 33 }, (_value, index) => ({
      index,
      name: `Recording ${index}`,
      candidateId: index.toString(16).padStart(64, "0")
    }));
    const client = api.createHoshidictsAudioClient({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ candidates })
      }))
    });

    await expect(client.getCandidates({
      term: "食べる",
      reading: "たべる",
      sourceId: "fast-audio"
    })).resolves.toEqual(candidates);
  });

  it("returns empty media responses without validating them in the client", async () => {
    const dom = createDom();
    const api = loadAudioModule(dom.window as unknown as Window);
    const media = new Blob([], { type: "text/html" });
    const client = api.createHoshidictsAudioClient({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => media
      }))
    });

    await expect(client.getMedia({
      term: "食べる",
      reading: "たべる",
      sourceId: "fast-audio",
      candidateIndex: 0,
      candidateId: CANDIDATE_ID
    })).resolves.toBe(media);
  });

  it("streams loopback candidates without buffering them through GSM", async () => {
    const play = vi.fn(async () => undefined);
    const playback = audioElement({ play });
    const client = {
      getCandidates: vi.fn(async () => [{
        index: 0,
        name: "Local",
        candidateId: CANDIDATE_ID,
        playbackUrl: "http://127.0.0.1:5050/audio.mp3"
      }]),
      getMedia: vi.fn()
    };
    const { button, controller } = createControllerHarness({
      client,
      createAudioElement: () => playback,
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn()
    });

    button.click();
    await flushPromises();

    expect(playback.src).toBe("http://127.0.0.1:5050/audio.mp3");
    expect(client.getMedia).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

});

describe("Hoshidicts audio controller", () => {
  it("starts autoplay on the next task and does not restart it during rerenders", async () => {
    vi.useFakeTimers();
    const play = vi.fn(async () => undefined);
    const client = {
      getCandidates: vi.fn(async () => [{
        index: 0,
        name: "Default",
        candidateId: CANDIDATE_ID
      }]),
      getMedia: vi.fn(async () => new Blob(["audio"], { type: "audio/mpeg" }))
    };
    const { button, controller, term } = createControllerHarness({
      client,
      render: false,
      profile: { autoPlay: true },
      createAudioElement: () => audioElement({ play }),
      createObjectURL: () => "blob:auto",
      revokeObjectURL: vi.fn()
    });
    const items = [{ button, result: term }];

    controller.setRenderedResults(items);
    controller.setRenderedResults(items, { autoPlay: false });
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(client.getCandidates).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);

    controller.setRenderedResults(items);
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(client.getCandidates).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it("derives availability from ordered sources and plays at full volume", async () => {
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    const revokeObjectURL = vi.fn();
    const playback = audioElement({ pause, play });
    const client = {
      getCandidates: vi.fn(async ({ sourceId }: { sourceId: string }) =>
        sourceId === "first"
          ? []
          : [{ index: 7, name: "Default", candidateId: CANDIDATE_ID }]
      ),
      getMedia: vi.fn(async () => new Blob(["audio"], { type: "audio/mpeg" }))
    };
    const { button, controller, term } = createControllerHarness({
      client,
      sources: [
        { id: "first", type: "custom", url: "https://first.test/{term}", voice: "" },
        { id: "second", type: "custom", url: "https://second.test/{term}", voice: "" }
      ],
      profile: { enabled: false, volume: 40 },
      createAudioElement: () => playback,
      createObjectURL: () => "blob:pronunciation",
      revokeObjectURL
    });
    expect(button.hidden).toBe(false);

    button.click();
    await flushPromises();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    expect(client.getCandidates).toHaveBeenCalledTimes(2);
    expect(client.getMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "second",
        candidateIndex: 7,
        candidateId: CANDIDATE_ID
      }),
      expect.objectContaining({ signal: expect.anything() })
    );
    expect(controller.getSelection(term)).toEqual({
      sourceId: "second",
      candidateIndex: 7,
      candidateId: CANDIDATE_ID
    });
    expect(button.dataset.state).toBe("playing");
    expect(playback.volume).toBe(1);
    controller.destroy();
    expect(pause).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pronunciation");
  });

  it("bounds ordered fallback with one total deadline", async () => {
    vi.useFakeTimers();
    const aborts = vi.fn();
    const getCandidates = vi.fn(
      async (_request: unknown, { signal }: { signal: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborts();
            reject(new Error("cancelled"));
          }, { once: true });
        })
    );
    const { button, controller } = createControllerHarness({
      client: { getCandidates, getMedia: vi.fn() },
      sources: [
        { id: "first", type: "jpod101", url: "", voice: "" },
        { id: "second", type: "jisho", url: "", voice: "" }
      ],
      fallbackTimeoutMs: 50,
      setTimeout,
      clearTimeout
    });

    button.click();
    await flushPromises();
    expect(getCandidates).toHaveBeenCalledTimes(1);
    expect(button.dataset.state).toBe("loading");

    await vi.advanceTimersByTimeAsync(50);
    await flushPromises();

    expect(aborts).toHaveBeenCalledTimes(1);
    expect(getCandidates).toHaveBeenCalledTimes(1);
    expect(button.dataset.state).toBe("error");
    expect(button.title).toMatch(/timed out/iu);
    controller.destroy();
  });

  it("tries ordered fallback candidates without an attempt cap", async () => {
    const sources = Array.from({ length: 13 }, (_value, index) => ({
      id: `source-${index}`,
      type: "custom",
      url: `https://audio.test/${index}/{term}`,
      voice: ""
    }));
    const getCandidates = vi.fn(async () => [
      { index: 0, name: "Recording", candidateId: CANDIDATE_ID }
    ]);
    const getMedia = vi.fn(async ({ sourceId }: { sourceId: string }) => {
      if (sourceId === sources[sources.length - 1].id) {
        return new Blob(["audio"], { type: "audio/mpeg" });
      }
      throw new Error("unplayable");
    });
    const play = vi.fn(async () => undefined);
    const { button, controller } = createControllerHarness({
      client: { getCandidates, getMedia },
      sources,
      createAudioElement: () => audioElement({ play }),
      createObjectURL: () => "blob:last-candidate",
      revokeObjectURL: vi.fn()
    });

    button.click();
    await vi.waitFor(() => {
      expect(getCandidates).toHaveBeenCalledTimes(13);
      expect(getMedia).toHaveBeenCalledTimes(13);
      expect(play).toHaveBeenCalledTimes(1);
      expect(button.dataset.state).toBe("playing");
    });
    controller.destroy();
  });

  it("uses the same trimmed term strings for discovery and media selection", async () => {
    const getCandidates = vi.fn(async () => [{
      index: 0,
      name: "Default",
      candidateId: CANDIDATE_ID
    }]);
    const getMedia = vi.fn(async () => new Blob(["audio"], { type: "audio/mpeg" }));
    const { button, controller } = createControllerHarness({
      client: { getCandidates, getMedia },
      term: result("  食べる  ", "  たべる  "),
      createAudioElement: () => audioElement(),
      createObjectURL: () => "blob:trimmed",
      revokeObjectURL: vi.fn()
    });

    button.click();
    await flushPromises();

    expect(getCandidates).toHaveBeenCalledWith({
      term: "食べる",
      reading: "たべる",
      sourceId: "jisho"
    }, expect.anything());
    expect(getMedia).toHaveBeenCalledWith(expect.objectContaining({
      term: "食べる",
      reading: "たべる"
    }), expect.anything());
    controller.destroy();
  });

  it("uses term and reading TTS locally at full volume without a mining selection", async () => {
    const dom = createDom();
    const speak = vi.fn();
    const cancel = vi.fn();
    const utterances: Array<Record<string, any>> = [];
    class FakeUtterance {
      text: string;
      lang = "";
      volume = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
        utterances.push(this as unknown as Record<string, any>);
      }
    }
    Object.assign(dom.window, {
      SpeechSynthesisUtterance: FakeUtterance,
      speechSynthesis: {
        cancel,
        getVoices: () => [{ name: "Haruka", voiceURI: "haruka" }],
        speak
      }
    });
    const { button, controller, term } = createControllerHarness({
      dom,
      sources: [{
        id: "reading-tts",
        type: "text-to-speech-reading",
        url: "",
        voice: "haruka"
      }],
      profile: { volume: 25 },
      term: result("食べた", "たべた")
    });

    button.click();
    await flushPromises();

    expect(speak).toHaveBeenCalledTimes(1);
    expect(utterances[0]).toMatchObject({
      text: "たべた",
      lang: "ja-JP",
      volume: 1
    });
    expect(controller.getSelection(term)).toBeNull();
    controller.destroy();
    expect(cancel).toHaveBeenCalled();
  });

  it("forgets a mining selection when playback later emits an error", async () => {
    const listeners = new Map<string, () => void>();
    const { button, controller, term } = createControllerHarness({
      client: {
        getCandidates: vi.fn(async () => [{
          index: 0,
          name: "Default",
          candidateId: CANDIDATE_ID
        }]),
        getMedia: vi.fn(async () => new Blob(["audio"], { type: "audio/mpeg" }))
      },
      createAudioElement: () => audioElement({
        addEventListener: vi.fn((name: string, callback: () => void) => {
          listeners.set(name, callback);
        })
      }),
      createObjectURL: () => "blob:late-error",
      revokeObjectURL: vi.fn()
    });

    button.click();
    await flushPromises();
    await vi.waitFor(() => {
      expect(controller.getSelection(term)).toEqual({
        sourceId: "jisho",
        candidateIndex: 0,
        candidateId: CANDIDATE_ID
      });
    });

    listeners.get("error")?.();
    expect(controller.getSelection(term)).toBeNull();
    controller.destroy();
  });

  it("cancels stale and manual autoplay while preserving configured autoplay", async () => {
    vi.useFakeTimers();
    const pause = vi.fn();
    const play = vi.fn(async () => undefined);
    const { controller, dom } = createControllerHarness({
      render: false,
      client: {
        getCandidates: vi.fn(async () => [{
          index: 0,
          name: "Default",
          candidateId: CANDIDATE_ID
        }]),
        getMedia: vi.fn(async () => new Blob(["audio"], { type: "audio/mpeg" }))
      },
      profile: { autoPlay: true },
      createAudioElement: () => audioElement({ pause, play }),
      createObjectURL: () => "blob:auto",
      revokeObjectURL: vi.fn()
    });
    const first = dom.window.document.createElement("button");
    const second = dom.window.document.createElement("button");
    const third = dom.window.document.createElement("button");
    controller.setRenderedResults([{ button: first, result: result("読む", "よむ") }]);
    controller.beginLookup();
    await vi.advanceTimersByTimeAsync(500);
    expect(play).not.toHaveBeenCalled();

    controller.setRenderedResults([{ button: second, result: result("聞く", "きく") }]);
    await vi.advanceTimersByTimeAsync(400);
    await flushPromises();
    expect(play).toHaveBeenCalledTimes(1);

    controller.setRenderedResults([{ button: third, result: result("話す", "はなす") }]);
    third.click();
    await flushPromises();
    expect(play).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(play).toHaveBeenCalledTimes(2);

    const pauseCount = pause.mock.calls.length;
    controller.updatePreferences({ autoPlay: false });
    expect(pause).toHaveBeenCalledTimes(pauseCount);
    expect(third.dataset.state).toBe("playing");
    controller.updatePreferences({
      sources: [{ id: "custom", type: "custom", url: "https://audio.test", voice: "" }]
    });
    expect(pause).toHaveBeenCalledTimes(pauseCount + 1);
    controller.destroy();
  });

  it("opens an accessible source menu on Shift-click and plays that exact variant", async () => {
    vi.useFakeTimers();
    const play = vi.fn(async () => undefined);
    const client = {
      getCandidates: vi.fn(async () => [
        { index: 1, name: "Female", candidateId: CANDIDATE_ID },
        { index: 2, name: "Male", candidateId: SECOND_CANDIDATE_ID }
      ]),
      getMedia: vi.fn(async () => new Blob(["audio"], { type: "audio/mpeg" }))
    };
    const { button, controller, dom, term } = createControllerHarness({
      appendButton: true,
      client,
      profile: { autoPlay: true },
      sources: [{ id: "jpod", type: "jpod101", url: "", voice: "" }],
      createAudioElement: () => audioElement({ play }),
      createObjectURL: () => "blob:menu",
      revokeObjectURL: vi.fn(),
      fallbackTimeoutMs: 1,
      maxFallbackAttempts: 1
    });

    button.dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: true,
      shiftKey: true
    }));
    await flushPromises();

    const menu = dom.window.document.querySelector<HTMLElement>(
      ".gsm-hoshidicts-audio-menu"
    );
    expect(menu?.getAttribute("role")).toBe("menu");
    expect(menu?.textContent).toContain("Female");
    expect(menu?.textContent).toContain("Male");
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getMedia).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    const variants = menu!.querySelectorAll<HTMLButtonElement>(
      ".gsm-hoshidicts-audio-menu-item"
    );
    variants[1].click();
    await flushPromises();

    expect(client.getMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "jpod",
        candidateIndex: 2,
        candidateId: SECOND_CANDIDATE_ID
      }),
      expect.objectContaining({ signal: expect.anything() })
    );
    expect(controller.getSelection(term)).toEqual({
      sourceId: "jpod",
      candidateIndex: 2,
      candidateId: SECOND_CANDIDATE_ID
    });
    expect(dom.window.document.querySelector(".gsm-hoshidicts-audio-menu"))
      .toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getMedia).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it("bounds concurrent source discovery when opening the source menu", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const getCandidates = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return [];
    });
    const sources = Array.from({ length: 10 }, (_, index) => ({
      id: `source-${index}`,
      type: "custom",
      url: `https://audio.test/${index}`,
      voice: ""
    }));
    const { button, controller, dom } = createControllerHarness({
      appendButton: true,
      client: { getCandidates, getMedia: vi.fn() },
      sources
    });

    button.dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: true,
      shiftKey: true
    }));
    await flushPromises();
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(getCandidates).toHaveBeenCalledTimes(3);

    while (releases.length > 0 || getCandidates.mock.calls.length < sources.length) {
      releases.splice(0).forEach((release) => release());
      await flushPromises();
    }

    expect(getCandidates).toHaveBeenCalledTimes(sources.length);
    expect(maximumActive).toBeLessThanOrEqual(3);
    controller.destroy();
  });
});
