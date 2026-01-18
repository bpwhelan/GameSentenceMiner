import { BehaviorSubject, skip } from 'rxjs';

import { writableSubject } from './writeable-subject';

export function writableStorageSubject<T>(mapFromString: (s: string) => T, mapToString: (t: T) => string) {
	return (key: string, defaultValue: T, persistenceBehavior?: BehaviorSubject<boolean>) => {
		const initValue = getStoredOrDefault()(key, defaultValue, mapFromString);
		const subject = writableSubject(initValue);

		let persist = true;

		if (persistenceBehavior) {
			persistenceBehavior.subscribe((shallPersist) => (persist = shallPersist));
		}

		subject.pipe(skip(1)).subscribe((updatedValue) => {
			if (persist) {
				window.localStorage.setItem(key, mapToString(updatedValue ?? defaultValue));
			}
		});
		return subject;
	};
}

function getStoredOrDefault() {
	return <T>(key: string, defaultVal: T, mapFn: (s: string) => T) => {
		const stored = window.localStorage.getItem(key);
		return stored ? mapFn(stored) : defaultVal;
	};
}
