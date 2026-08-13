/**
 * Bounded-concurrency map: run async workers over items with at most
 * `concurrency` in flight. Used by the evaluation matrix so case × run units
 * execute in parallel without unbounded subagent fan-out.
 */
export async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}
	const results = new Array<R>(items.length);
	const limit = Math.max(1, Math.min(concurrency, items.length));
	let next = 0;
	async function runner(): Promise<void> {
		while (true) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T, index);
		}
	}
	await Promise.all(Array.from({ length: limit }, () => runner()));
	return results;
}
