import { BehaviorSubject } from 'rxjs';
import { subjectToSvelteWritable } from './subject-to-writeable';

export function writableSubject<T>(value: T) {
	return subjectToSvelteWritable(new BehaviorSubject<T>(value));
}
