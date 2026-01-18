import { writableStorageSubject } from './writable-storage-subject';

export function writableBooleanSubject() {
	return writableStorageSubject(
		(x) => !!+x,
		(x) => (x ? '1' : '0')
	);
}
