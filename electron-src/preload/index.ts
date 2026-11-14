import { clipboard, contextBridge, ipcRenderer } from "electron";

import { isAllowedChannel, type ChannelMode } from "../shared/desktopChannels.js";

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
