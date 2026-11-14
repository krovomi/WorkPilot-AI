/**
 * `fetch` for the local backend, through main.
 *
 * The renderer has no backend URL (`VITE_BACKEND_URL` is never set there, so
 * `${VITE_BACKEND_URL}/x` was a relative URL the Vite dev server answered with
 * its HTML page). Main makes the request and returns the backend's answer as a
 * `Response`, so a caller reads it as it read `fetch`'s. Nothing answering
 * rejects with a `TypeError`, as `fetch` does; an aborted signal with an
 * `AbortError`.
 */

import type { LocalBackendResponse } from "@shared/types/local-backend";

export interface LocalBackendInit {
	method?: "GET" | "POST";
	body?: string;
	signal?: AbortSignal;
	/** The answer is a file (an image, a video, a zip): read it with `blob()`. */
	binary?: boolean;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function aborted(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

export async function localBackendFetch(
	url: string,
	init: LocalBackendInit = {},
): Promise<Response> {
	const { signal } = init;
	if (signal?.aborted) throw aborted();
	const request = globalThis.electronAPI.localBackendRequest({
		method: init.method ?? "GET",
		url,
		body: init.body,
		...(init.binary ? { binary: true } : {}),
	});
	const answer: LocalBackendResponse = signal
		? await new Promise<LocalBackendResponse>((resolve, reject) => {
				const onAbort = () => reject(aborted());
				signal.addEventListener("abort", onAbort, { once: true });
				request.then(resolve, reject).finally(() => {
					signal.removeEventListener("abort", onAbort);
				});
			})
		: await request;
	if ("unreachable" in answer) throw new TypeError("Failed to fetch");
	// A copy on its own ArrayBuffer: what crossed IPC may be a view of a shared one.
	const content = "bytes" in answer ? new Uint8Array(answer.bytes) : answer.text;
	return new Response(NULL_BODY_STATUSES.has(answer.status) ? null : content, {
		status: answer.status,
		headers: { "content-type": answer.contentType },
	});
}

/**
 * A `blob:` URL for a file the local backend serves (a screenshot, a video, a
 * trace), which an `<img>`, a `<video>` or a download link can use: the page's
 * CSP lets it load neither the backend's address nor a relative one.
 */
export async function localBackendObjectUrl(
	url: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const res = await localBackendFetch(url, { binary: true, signal });
	if (!res.ok) return null;
	return URL.createObjectURL(await res.blob());
}
