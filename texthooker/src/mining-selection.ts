export type MiningUpdate = { id: string; checked: boolean };
export type MiningStartDetail = { id: string; checked: boolean; event: PointerEvent };
export type MiningClickDetail = { id: string; event: MouseEvent };

/** Recompute from the gesture's starting state so dragging back shrinks the range. */
export function selectMiningRange(
	initial: ReadonlySet<string>, order: readonly string[], anchor: string, end: string, checked: boolean,
): Set<string> {
	const first = order.indexOf(anchor);
	const last = order.indexOf(end);
	const selected = new Set(initial);
	if (first < 0 || last < 0) return selected;
	for (const id of order.slice(Math.min(first, last), Math.max(first, last) + 1)) {
		if (checked) selected.add(id);
		else selected.delete(id);
	}
	return selected;
}

export function miningSelectionChanges(before: ReadonlySet<string>, after: ReadonlySet<string>): MiningUpdate[] {
	return [...new Set([...before, ...after])]
		.filter((id) => before.has(id) !== after.has(id))
		.map((id) => ({ id, checked: after.has(id) }));
}
