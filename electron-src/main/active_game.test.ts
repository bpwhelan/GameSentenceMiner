import { describe, expect, it } from 'vitest';
import { ActiveGameTracker } from './active_game.js';

describe('shared active game evidence', () => {
    it('starts immediately but requires repeated missing-window evidence before closing', () => {
        const tracker = new ActiveGameTracker();
        tracker.update({ sceneName: 'Game', active: true }, 1000);
        expect(tracker.get('Game', 1000)).toBe(true);
        tracker.update({ sceneName: 'Game', active: false }, 2000);
        expect(tracker.get('Game', 2000)).toBeNull();
        tracker.update({ sceneName: 'Game', active: false }, 7000);
        expect(tracker.get('Game', 7000)).toBe(false);
    });

    it('does not count stale or unknown evidence as continuous inactivity', () => {
        const tracker = new ActiveGameTracker();
        tracker.update({ sceneName: 'Game', active: false }, 1000);
        expect(tracker.get('Game', 7000)).toBeNull();
        tracker.update({ sceneName: 'Game', active: false }, 7000);
        expect(tracker.get('Game', 7000)).toBeNull();
        tracker.update({ sceneName: 'Game', active: null }, 8000);
        tracker.update({ sceneName: 'Game', active: false }, 9000);
        expect(tracker.get('Game', 9000)).toBeNull();
    });

    it('isolates scene changes and resets loss timing on recovery', () => {
        const tracker = new ActiveGameTracker();
        tracker.update({ sceneName: 'Game', active: false }, 1000);
        tracker.update({ sceneName: 'Other', active: false }, 5000);
        expect(tracker.get('Other', 5000)).toBeNull();
        expect(tracker.get('Game', 5000)).toBeNull();
        tracker.update({ sceneName: 'Other', active: true }, 6000);
        expect(tracker.get('Other', 6000)).toBe(true);
        tracker.update({ sceneName: 'Other', active: false }, 7000);
        expect(tracker.get('Other', 7000)).toBeNull();
    });

    it('ignores malformed evidence', () => {
        const tracker = new ActiveGameTracker();
        tracker.update({ sceneName: 'Game', active: 'false' }, 1000);
        expect(tracker.get('Game', 1000)).toBeNull();
        tracker.update({ sceneName: 'Game', active: true, observedAt: 1000 }, 20_000);
        expect(tracker.get('Game', 20_000)).toBeNull();
    });
});
