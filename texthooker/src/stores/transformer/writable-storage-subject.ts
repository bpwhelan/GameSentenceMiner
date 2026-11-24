import { BehaviorSubject, skip } from 'rxjs';

import { writableSubject } from './writeable-subject';

export function writableStorageSubject<T>(mapFromString: (s: string) => T, mapToString: (t: T) => string) {
	return (key: string, defaultValue: T, persistenceBehavior?: BehaviorSubject<boolean>, writeInterval = 0) => {
		const initValue = getStoredOrDefault()(key, defaultValue, mapFromString);
		const subject = writableSubject(initValue);

		let persist = true;
		let pendingWrite: number | undefined;
		function flush() {
			if (pendingWrite !== undefined) window.clearTimeout(pendingWrite);
			pendingWrite = undefined;
			if (!persist) return;
			try {
				window.localStorage.setItem(key, mapToString(subject.getValue() ?? defaultValue));
			} catch (error) {
				// A large transcript can exceed the browser's storage quota. Keep the live feed running.
				console.warn(`Could not save ${key}`, error);
			}
		}

		if (persistenceBehavior) {
			persistenceBehavior.subscribe((shallPersist) => {
				persist = shallPersist;
				if (!persist && pendingWrite !== undefined) {
					window.clearTimeout(pendingWrite);
					pendingWrite = undefined;
				}
			});
		}

		subject.pipe(skip(1)).subscribe(() => {
			if (!persist) return;
			if (!writeInterval) flush();
			else if (pendingWrite === undefined) pendingWrite = window.setTimeout(flush, writeInterval);
		});
		if (writeInterval) {
			window.addEventListener('pagehide', () => {
				if (pendingWrite !== undefined) flush();
			});
			document.addEventListener('visibilitychange', () => {
				if (document.hidden && pendingWrite !== undefined) flush();
			});
		}
		return Object.assign(subject, {
			clearStoredValue() {
				if (pendingWrite !== undefined) window.clearTimeout(pendingWrite);
				pendingWrite = undefined;
				window.localStorage.removeItem(key);
			},
		});
	};
}

function getStoredOrDefault() {
	return <T>(key: string, defaultVal: T, mapFn: (s: string) => T) => {
		const stored = window.localStorage.getItem(key);
		return stored ? mapFn(stored) : defaultVal;
	};
}
