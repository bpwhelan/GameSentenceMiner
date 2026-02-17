export interface IpcEventLike {
  sender: unknown;
}

export interface IpcBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  send(channel: string, ...args: unknown[]): void;
  on(
    channel: string,
    listener: (event: IpcEventLike, ...args: unknown[]) => void
  ): () => void;
  once(
    channel: string,
    listener: (event: IpcEventLike, ...args: unknown[]) => void
  ): void;
  removeListener(
    channel: string,
    listener: (event: IpcEventLike, ...args: unknown[]) => void
  ): void;
  removeAllListeners(channel: string): void;
}

export interface ClipboardBridge {
  readText(): string;
  writeText(text: string): void;
}

declare global {
  interface Window {
    ipcRenderer: IpcBridge;
    clipboard: ClipboardBridge;
    gsmEnv: {
      platform: string;
    };
  }
}
