import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One registered project: /work/app. Everything else is outside.
vi.mock("../../security/renderer-path", () => ({
	resolveInProject: (target: unknown) =>
		typeof target === "string" && (target === "/work/app" || target.startsWith("/work/app/"))
			? target
			: null,
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { checkRequest, localBackendRequest, ROUTES } from "../local-backend-handlers";

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VITE_BACKEND_URL", "");
	vi.stubEnv("BACKEND_URL", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function refused(raw: unknown): string | undefined {
	const checked = checkRequest(raw);
	return "refused" in checked ? checked.refused : undefined;
}

describe("what the renderer may ask the local backend", () => {
	it("sends a listed route to the backend this app runs", () => {
		const checked = checkRequest({ method: "GET", url: "/api/rtk/status?project_dir=/work/app" });
		expect("url" in checked && checked.url.href).toBe(
			"http://127.0.0.1:9000/api/rtk/status?project_dir=/work/app",
		);
		expect(refused({ method: "GET", url: "/api/slash-commands" })).toBeUndefined();
		expect(refused({ method: "GET", url: "/providers/models/ollama" })).toBeUndefined();
	});

	it("refuses a route it does not list", () => {
		expect(refused({ method: "GET", url: "/api/settings/secrets" })).toBe("route");
		expect(refused({ method: "GET", url: "/api/rtkfoo" })).toBe("route");
		expect(refused({ method: "GET", url: "/" })).toBe("route");
		expect(ROUTES.every((route) => route.startsWith("/"))).toBe(true);
	});

	it("refuses another host, a scheme-relative URL and a climb out of a route", () => {
		expect(refused({ method: "GET", url: "//evil.test/api/rtk/status" })).toBe("route");
		expect(refused({ method: "GET", url: "http://evil.test/api/rtk/" })).toBe("url");
		expect(refused({ method: "GET", url: "/api/rtk/%2e%2e/%2e%2e/admin" })).toBe("route");
		expect(refused({ method: "GET", url: "/api/rtk/..%2F..%2Fadmin" })).toBe("route");
	});

	it("refuses other methods and malformed requests", () => {
		expect(refused({ method: "DELETE", url: "/api/rtk/status" })).toBe("method");
		expect(refused(null)).toBe("invalid request");
		expect(refused({ method: "GET", url: 42 })).toBe("url");
		expect(refused({ method: "GET", url: `/api/rtk/${"a".repeat(9000)}` })).toBe("url");
	});

	it("refuses a folder outside the registered projects, in the query or the body", () => {
		expect(refused({ method: "GET", url: "/api/verify/screenshot?project_dir=/etc&index=0" })).toBe(
			"folder",
		);
		expect(
			refused({
				method: "POST",
				url: "/api/brain/status",
				body: JSON.stringify({ project_dir: "/work/app" }),
			}),
		).toBeUndefined();
		expect(
			refused({
				method: "POST",
				url: "/api/brain/status",
				body: JSON.stringify({ nested: { deeper: { spec_dir: "/home/someone/.ssh" } } }),
			}),
		).toBe("folder");
		expect(
			refused({ method: "POST", url: "/api/brain/status", body: JSON.stringify({ projectPath: 7 }) }),
		).toBe("folder");
	});

	it("refuses a body that is not JSON, too large, or on a GET", () => {
		expect(refused({ method: "POST", url: "/api/brain/status", body: "{" })).toBe("body");
		expect(refused({ method: "GET", url: "/api/brain/status", body: "{}" })).toBe("body");
		expect(
			refused({ method: "POST", url: "/api/brain/status", body: JSON.stringify({ x: "a".repeat(1_000_001) }) }),
		).toBe("body");
	});
});

describe("the answer handed back", () => {
	it("is the backend's raw text and status", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response('{"success":false,"error":"nope"}', {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
		);
		const answer = await localBackendRequest({
			method: "POST",
			url: "/api/brain/status",
			body: "{}",
		});
		expect(answer).toEqual({
			status: 404,
			contentType: "application/json",
			text: '{"success":false,"error":"nope"}',
		});
		const [, init] = fetchMock.mock.calls[0];
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "Content-Type": "application/json" });
	});

	it("is bytes for a file", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }),
		);
		const answer = await localBackendRequest({
			method: "GET",
			url: "/api/verify/screenshot?project_dir=/work/app&index=0",
			binary: true,
		});
		expect(answer).toMatchObject({ status: 200, contentType: "image/png" });
		expect(Array.from((answer as { bytes: Uint8Array }).bytes)).toEqual([1, 2, 3]);
	});

	it("refuses a file larger than it hands over", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("x", { status: 200, headers: { "content-length": String(300_000_000) } }),
		);
		const answer = await localBackendRequest({
			method: "GET",
			url: "/api/verify/video?project_dir=/work/app",
			binary: true,
		});
		expect(answer).toEqual({ unreachable: true });
	});

	it("says nothing answered when the backend is down", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		expect(await localBackendRequest({ method: "GET", url: "/api/rtk/status" })).toEqual({
			unreachable: true,
		});
	});

	it("never reaches the network for a refused request", async () => {
		const answer = await localBackendRequest({ method: "GET", url: "/api/admin" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toMatchObject({ status: 400 });
		expect(JSON.parse((answer as { text: string }).text)).toEqual({
			success: false,
			error: "Refused: route",
		});
	});
});
