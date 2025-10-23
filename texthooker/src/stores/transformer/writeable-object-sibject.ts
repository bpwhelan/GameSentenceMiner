import { writableStorageSubject } from './writable-storage-subject';

function createwritteableObjectSubject<T>(fallback: string) {
	return writableStorageSubject(
		(x) => JSON.parse(x || fallback) as T,
		(x) => JSON.stringify(x)
	);
}

export function writeableObjectSubject<T>() {
	return createwritteableObjectSubject<T>('{}');
}

export function writeableArraySubject<T>() {
	return createwritteableObjectSubject<T[]>('[]');
}
