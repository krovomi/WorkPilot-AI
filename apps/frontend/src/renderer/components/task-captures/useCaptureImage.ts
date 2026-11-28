import { useEffect, useState } from "react";

/** Copies kept in memory: a board's previews and one task's gallery. */
const MAX_CACHED = 48;
const cache = new Map<string, string>();

function remember(key: string, source: string): void {
	cache.delete(key);
	cache.set(key, source);
	while (cache.size > MAX_CACHED) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

export interface CaptureImageState {
	source: string | null;
	failed: boolean;
}

/**
 * One published copy of a task's captures as a `data:` URL, read by the main
 * process (`TASK_CAPTURES_IMAGE`) only when the publication lists it.
 * `version` (the publication's date) makes a capture taken again a new image.
 */
export function useCaptureImage(
	taskId: string,
	file: string | undefined,
	version?: string,
): CaptureImageState {
	const key = file ? `${taskId}|${file}|${version ?? ""}` : "";
	const [state, setState] = useState<CaptureImageState>(() => ({
		source: key ? (cache.get(key) ?? null) : null,
		failed: false,
	}));

	useEffect(() => {
		if (!key || !file) {
			setState({ source: null, failed: false });
			return;
		}
		const cached = cache.get(key);
		if (cached) {
			setState({ source: cached, failed: false });
			return;
		}
		const api = globalThis.electronAPI;
		if (typeof api?.getTaskCaptureImage !== "function") {
			setState({ source: null, failed: true });
			return;
		}
		let cancelled = false;
		setState({ source: null, failed: false });
		api
			.getTaskCaptureImage(taskId, file)
			.then((result) => {
				if (cancelled) return;
				if (result.success && result.data) {
					const source = `data:${result.data.mimeType};base64,${result.data.base64}`;
					remember(key, source);
					setState({ source, failed: false });
				} else {
					setState({ source: null, failed: true });
				}
			})
			.catch(() => {
				if (!cancelled) setState({ source: null, failed: true });
			});
		return () => {
			cancelled = true;
		};
	}, [key, taskId, file]);

	return state;
}

/** For tests: forget every copy. */
export function clearCaptureImageCache(): void {
	cache.clear();
}
