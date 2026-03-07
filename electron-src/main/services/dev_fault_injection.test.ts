import { beforeEach, describe, expect, it } from 'vitest';

import { devFaultInjector } from './dev_fault_injection.js';

describe('devFaultInjector', () => {
    beforeEach(() => {
        devFaultInjector.clearScenario();
    });

    it('injects once for an exact checkpoint', () => {
        devFaultInjector.configureScenario('unit-exact', {
            'update.sync_lockfile': 1,
        });

        expect(() => {
            devFaultInjector.maybeFail('update.sync_lockfile');
        }).toThrow(/Injected failure/);

        expect(() => {
            devFaultInjector.maybeFail('update.sync_lockfile');
        }).not.toThrow();
    });

    it('supports wildcard fallback checkpoint', () => {
        devFaultInjector.configureScenario('unit-wildcard', {
            '*': 1,
        });

        expect(() => {
            devFaultInjector.maybeFail('any.checkpoint');
        }).toThrow(/any\.checkpoint/);
    });

    it('records last injected failure metadata', () => {
        devFaultInjector.configureScenario('unit-metadata', {
            'startup.run_gsm': 1,
        });

        expect(() => {
            devFaultInjector.maybeFail('startup.run_gsm');
        }).toThrow();

        const injected = devFaultInjector.getLastInjectedFailure();
        expect(injected).not.toBeNull();
        expect(injected?.scenario).toBe('unit-metadata');
        expect(injected?.checkpoint).toBe('startup.run_gsm');
        expect(typeof injected?.timestamp).toBe('string');
    });
});
