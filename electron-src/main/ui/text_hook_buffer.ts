/** Buffer completed hook fragments, replacing cumulative typewriter prefixes. */
export function appendHookFragment<T extends { text: string; capturedAt?: number }>(pending: T[], payload: T): void {
    const previous = pending.at(-1);
    if (previous && payload.text.startsWith(previous.text)) {
        pending[pending.length - 1] = { ...payload, capturedAt: previous.capturedAt ?? payload.capturedAt };
    } else if (!previous || !previous.text.startsWith(payload.text)) {
        pending.push(payload);
    }
}
