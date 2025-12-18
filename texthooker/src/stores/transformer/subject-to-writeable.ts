import type { Subject } from 'rxjs';

export function subjectToSvelteWritable<S extends Subject<any>>(subject: S) {
	// @ts-expect-error Svelte uses `set` like `next`
	subject.set = subject.next;
	return subject;
}
