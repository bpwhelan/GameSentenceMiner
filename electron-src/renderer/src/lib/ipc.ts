import type { IpcEventLike } from "../types/global";
import {invokeNative,listenNative} from './nativeCommands';

export function invokeIpc<T = unknown>(
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return invokeNative<T>(channel,args) ?? window.ipcRenderer.invoke<T>(channel, ...args);
}

export function sendIpc(channel: string, ...args: unknown[]): void {
  window.ipcRenderer.send(channel, ...args);
}

export function onIpc(
  channel: string,
  listener: (event: IpcEventLike, ...args: unknown[]) => void
): () => void {
  return listenNative(channel,listener) ?? window.ipcRenderer.on(channel, listener);
}

export function platformFromEnv(): "win32" | "darwin" | "linux" | string {
  return window.gsmEnv?.platform ?? "win32";
}
