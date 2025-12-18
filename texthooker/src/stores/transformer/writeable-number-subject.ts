import { writableStorageSubject } from './writable-storage-subject';

export function writableNumberSubject() {
	return writableStorageSubject<number>(
		(x) => +x,
		(x) => `${x}`
	);
}
