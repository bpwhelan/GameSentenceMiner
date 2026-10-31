// Imported by bootstrap before the large main-process module graph. Keep this
// leaf free of Electron/logging imports so it measures that work as well.
const startedAt = performance.now();
const milestones = new Set<string>();

export function markStartup(name: string): void {
    if (milestones.has(name)) return;
    milestones.add(name);
    console.log(`[Startup] ${name}: ${Math.round(performance.now() - startedAt)}ms since desktop bootstrap`);
}
