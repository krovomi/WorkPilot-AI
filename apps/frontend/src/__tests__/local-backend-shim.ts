/**
 * Tests stub the global `fetch` for the local backend; the renderer reaches it
 * through `electronAPI.localBackendRequest` (main makes the request). This
 * answers that call from the stubbed `fetch`, so a test that replaces
 * `electronAPI` keeps its backend stub by adding `localBackendRequest:
 * fetchLocalBackend`.
 */
export async function fetchLocalBackend({
	method,
	url,
	body,
}: {
	method: string;
	url: string;
	body?: string;
}) {
	try {
		const res = await globalThis.fetch(url, {
			method,
			...(body === undefined
				? {}
				: { headers: { "Content-Type": "application/json" }, body }),
		});
		const text =
			typeof res.text === "function"
				? await res.text()
				: JSON.stringify(await res.json());
		return {
			status: typeof res.status === "number" ? res.status : res.ok ? 200 : 500,
			contentType: res.headers?.get?.("content-type") ?? "application/json",
			text,
		};
	} catch {
		return { unreachable: true as const };
	}
}
