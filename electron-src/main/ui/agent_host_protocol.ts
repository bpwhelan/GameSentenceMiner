import type { TextHookArchitecture, TextHookStartSource } from './texthook.js';

export const AGENT_HOST_ARG = '--gsm-agent-host';
export const AGENT_HOST_OPTIONS_ARG = '--gsm-agent-host-options';
export const AGENT_HOST_PROTOCOL_VERSION = 1;

export interface DetachedAgentStartOptions {
    pid: number;
    exeName: string;
    arch: TextHookArchitecture;
    source: TextHookStartSource;
    scriptPath: string;
    flushDelayMs: number;
    copyToClipboard: boolean;
    maxBufferSize: number;
}

export interface AgentHostMetadata {
    version: number;
    hostPid: number;
    port: number;
    token: string;
    startedAt: number;
}

export interface AgentHostRequest {
    kind: 'request';
    id: number;
    command: string;
    args?: unknown[];
}

export interface AgentHostResponse {
    kind: 'response';
    id: number;
    success: boolean;
    result?: unknown;
    error?: string;
}

export interface AgentHostEvent {
    kind: 'event';
    channel: string;
    payload: unknown;
}

export type AgentHostMessage = AgentHostRequest | AgentHostResponse | AgentHostEvent;
