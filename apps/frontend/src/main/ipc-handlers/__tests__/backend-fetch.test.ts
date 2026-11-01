import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The app is signed in to a WorkPilot server for every test in this file.
vi.mock("../../server-connection", () => ({
	isServerMode: () => true,
	getServerUrl: () => "https://workpilot.example.test",
	getAccessToken: () => "session-token",
	refreshSession: vi.fn(async () => true),
}));

import { backendFetch, getBackendUrl } from "../_backend-fetch";

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

describe("machine features keep talking to the local backend while signed in to a server", () => {
	it("targets the backend the app runs on this machine", () => {
		expect(getBackendUrl()).toBe("http://127.0.0.1:9000");
	});

	it("sends the request there, without the server session", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ success: true, ok: 1 }), { status: 200 }),
		);

		const result = await backendFetch("/api/brain/status");

		expect(result).toEqual({ success: true, ok: 1 });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/api/brain/status");
		expect(init.headers).not.toHaveProperty("Authorization");
	});

	it("reports a refusal as is, without asking the server for a new session", async () => {
		fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));

		const result = await backendFetch("/api/hooks/emit", { method: "POST" });

		expect(result).toEqual({ success: false, error: "nope" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
