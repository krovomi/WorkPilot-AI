/**
 * Extract the list of files impacted by a subtask from an implementation plan.
 *
 * The backend planner stores impacted files under `files_to_modify` and
 * `files_to_create` (snake_case), NOT under a single `files` field. The UI
 * `Subtask` model however exposes a flat `files: string[]`. Without this
 * normalization the per-subtask "files modified" view is always empty even
 * though the plan does carry the data.
 *
 * `files` is kept as a fallback for any legacy plan or manually edited subtask
 * that already uses the flat shape. The result is order-preserving and
 * de-duplicated (modify entries first, then create entries).
 */
export function extractSubtaskFiles(subtask: {
	files?: unknown;
	files_to_modify?: unknown;
	files_to_create?: unknown;
}): string[] {
	const toStringArray = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];

	const merged = [
		...toStringArray(subtask.files_to_modify),
		...toStringArray(subtask.files_to_create),
		...toStringArray(subtask.files),
	];

	// De-duplicate while preserving first-seen order.
	return [...new Set(merged)];
}
