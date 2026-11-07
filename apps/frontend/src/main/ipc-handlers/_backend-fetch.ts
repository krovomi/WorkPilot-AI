/**
 * Shared helper for IPC handlers that proxy a request to the FastAPI
 * backend exposed by `apps/backend/provider_api.py`.
 *
 * It always targets the backend this app starts on the machine, even while
 * the app is signed in to a WorkPilot server: the features behind these
 * calls (hooks, brain memory, notifications, learning loop...) belong to the
 * machine. Server routes go through `authedFetch` (`server-connection.ts`),
 * which carries the session token; this helper never does.
 *
 * Most handlers for the new "Phase 3-5" feature modules look the same:
 * read a JSON body from the renderer, POST/GET it to a backend endpoint,
 * forward the JSON response back. This module hides the boilerplate.
 */

const DEFAULT_BACKEND_URL = "http://127.0.0.1:9000";

export function getBackendUrl(): string {
	return (
		process.env.VITE_BACKEND_URL ||
		process.env.BACKEND_URL ||
		DEFAULT_BACKEND_URL
	);
}

export interface BackendError {
	success: false;
	error: string;
}

export type BackendResult<T> = ({ success: true } & T) | BackendError;

/**
 * Fetch a backend endpoint and return its JSON body.
 *
 * Errors are normalised to `{ success: false, error: "..." }` so renderer
 * stores can rely on a single shape. We never throw across the IPC boundary
 * (Electron will mangle the stack trace anyway).
 */
export async function backendFetch<T = Record<string, unknown>>(
	path: string,
	init?: RequestInit,
	timeoutMs = 30_000,
): Promise<BackendResult<T>> {
	const doFetch = async (): Promise<Response> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(`${getBackendUrl()}${path}`, {
				headers: {
					"Content-Type": "application/json",
					...(init?.headers || {}),
				},
				signal: controller.signal,
				...init,
			});
		} finally {
			clearTimeout(timer);
		}
	};

	try {
		const res = await doFetch();
		const text = await res.text();
		if (!res.ok) {
			return { success: false, error: text || `HTTP ${res.status}` };
		}
		try {
			return JSON.parse(text) as BackendResult<T>;
		} catch {
			return { success: false, error: "Backend returned non-JSON response" };
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, error: msg };
	}
}
