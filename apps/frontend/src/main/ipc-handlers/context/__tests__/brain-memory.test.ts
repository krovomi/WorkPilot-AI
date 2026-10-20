import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ backendFetch: vi.fn() }));
vi.mock("../../_backend-fetch", () => ({ backendFetch: mocks.backendFetch }));

import {
	fetchBrainMemoryStatus,
	loadBrainMemories,
	searchBrainMemories,
} from "../brain-memory";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the Memories tab reads the shared brain", () => {
	it("reports the vault as the store once it exists", async () => {
		mocks.backendFetch.mockResolvedValueOnce({
			success: true,
			exists: true,
			root: "/home/me/.workpilot/brain",
		});
		expect(await fetchBrainMemoryStatus()).toEqual({
			enabled: true,
			available: true,
			database: "WorkPilot Brain",
			dbPath: "/home/me/.workpilot/brain",
		});
		expect(mocks.backendFetch.mock.calls[0][0]).toBe("/api/brain/status");
	});

	it("says the vault is not created yet rather than 'Graphiti not configured'", async () => {
		mocks.backendFetch.mockResolvedValueOnce({ success: true, exists: false });
		const status = await fetchBrainMemoryStatus();
		expect(status.available).toBe(false);
		expect(status.reason).toBe("reasons.brainNotCreated");
	});

	it("never throws when the backend is down", async () => {
		mocks.backendFetch.mockResolvedValue({ success: false, error: "offline" });
		expect((await fetchBrainMemoryStatus()).reason).toBe(
			"reasons.brainUnreachable",
		);
		expect(await loadBrainMemories("/p", 20)).toEqual([]);
		expect(await searchBrainMemories("/p", "x", 20)).toEqual([]);
	});

	it("names the project by its path and passes the query", async () => {
		mocks.backendFetch.mockResolvedValueOnce({
			success: true,
			results: [{ content: "gotcha", score: 1, type: "gotcha" }],
		});
		const results = await searchBrainMemories("/work/shop", "cache & tenant", 20);
		expect(results).toHaveLength(1);
		const url = new URL(`http://x${mocks.backendFetch.mock.calls[0][0]}`);
		expect(url.pathname).toBe("/api/brain/memories");
		expect(url.searchParams.get("project_dir")).toBe("/work/shop");
		expect(url.searchParams.get("query")).toBe("cache & tenant");
	});
});
