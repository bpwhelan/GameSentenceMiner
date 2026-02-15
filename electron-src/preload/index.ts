import { clipboard, contextBridge, ipcRenderer } from "electron";

type ChannelMode = "invoke" | "send" | "on";

const invokeExactChannels = new Set<string>([
  "show-error-box",
  "show-message-box",
  "open-external",
  "get-platform",
  "openOBS",
  "open-external-link",
  "openTexthooker",
  "runOverlay",
  "run-furigana-window",
  "get_gsm_status",
  "ocr-replacements.load",
  "ocr-replacements.save"
]);

const sendExactChannels = new Set<string>([
  "tab-changed",
  "terminal-data",
  "hide",
  "show",
  "release-mouse",
  "open-settings",
  "open-yomitan-settings",
  "reply-current-settings",
  "close-furigana-window",
  "app-close",
  "app-minimize"
]);

const onExactChannels = new Set<string>([
  "installing",
  "steamGamesUpdated",
  "state-cleared",
  "notification",
  "load-settings",
  "display-info",
  "afk-hide",
  "show-overlay-hotkey",
  "toggle-furigana-visibility",
  "force-visible",
  "toggle-main-box",
  "new-magpieCompatibility",
  "furigana-script-result",
  "set-furigana-character",
  "preload-settings"
]);

const invokePrefixes = [
  "state.",
  "settings.",
  "python.",
  "logs.",
  "ocr.",
  "obs.",
  "steam.",
  "vn.",
  "yuzu.",
  "front.",
  "wanakana-",
  "kuroshiro-"
];

const sendPrefixes = [
  "ocr.",
  "settings.",
  "websocket-",
  "yomitan-",
  "toggle-",
  "update-",
  "set-",
  "resize-",
  "open-",
  "setting-",
  "text-"
];

const onPrefixes = [
  "terminal-",
  "ocr-",
  "state-",
  "websocket-",
  "settings-",
  "gsm-"
];

function isValidChannelName(channel: string): boolean {
  return /^[a-zA-Z0-9._:-]+$/.test(channel);
}

function isAllowedChannel(mode: ChannelMode, channel: string): boolean {
  if (!isValidChannelName(channel)) {
    return false;
  }

  if (mode === "invoke") {
    return (
      invokeExactChannels.has(channel) ||
      invokePrefixes.some((prefix) => channel.startsWith(prefix))
    );
  }

  if (mode === "send") {
    return (
      sendExactChannels.has(channel) ||
      sendPrefixes.some((prefix) => channel.startsWith(prefix))
    );
  }

  return (
    onExactChannels.has(channel) ||
    onPrefixes.some((prefix) => channel.startsWith(prefix))
  );
}

function assertAllowed(mode: ChannelMode, channel: string) {
  if (!isAllowedChannel(mode, channel)) {
    throw new Error(`Blocked IPC channel for ${mode}: ${channel}`);
  }
}

type RendererListener = (event: { sender: null }, ...args: unknown[]) => void;

const wrappedListenerMap = new WeakMap<RendererListener, (...args: unknown[]) => void>();

const ipcBridge = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    assertAllowed("invoke", channel);
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
  send(channel: string, ...args: unknown[]): void {
    assertAllowed("send", channel);
    ipcRenderer.send(channel, ...args);
  },
  on(channel: string, listener: RendererListener): () => void {
    assertAllowed("on", channel);
    const wrapped = (_event: unknown, ...args: unknown[]) => {
      listener({ sender: null }, ...args);
    };
    wrappedListenerMap.set(listener, wrapped);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  once(channel: string, listener: RendererListener): void {
    assertAllowed("on", channel);
    ipcRenderer.once(channel, (_event: unknown, ...args: unknown[]) => {
      listener({ sender: null }, ...args);
    });
  },
  removeListener(channel: string, listener: RendererListener): void {
    assertAllowed("on", channel);
    const wrapped = wrappedListenerMap.get(listener);
    if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
    }
  },
  removeAllListeners(channel: string): void {
    assertAllowed("on", channel);
    ipcRenderer.removeAllListeners(channel);
  }
};

contextBridge.exposeInMainWorld("ipcRenderer", ipcBridge);
contextBridge.exposeInMainWorld("clipboard", {
  readText: () => clipboard.readText(),
  writeText: (text: string) => clipboard.writeText(String(text ?? ""))
});
contextBridge.exposeInMainWorld("gsmEnv", {
  platform: process.platform
});
