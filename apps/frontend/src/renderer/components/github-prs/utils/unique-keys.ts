/**
 * React keys for items that can repeat what a key is made of: log lines in
 * the same second, two violations in one file. A key made of that alone made
 * React drop or repeat the twins; the n-th twin gets "#n".
 */
export function withUniqueKeys<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
): Array<{ key: string; item: T }> {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const base = keyOf(item);
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return { key: `${base}#${n}`, item };
	});
}
