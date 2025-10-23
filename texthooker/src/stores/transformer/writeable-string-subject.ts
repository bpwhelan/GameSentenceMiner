import { writableStorageSubject } from './writable-storage-subject';

export function writableStringSubject<T extends string>() {
	return writableStorageSubject(
		(x) => x as T,
		(x) => x
	);
}
