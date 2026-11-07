import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { forkBody } from "./time-travel-handlers";

describe("forkBody", () => {
	it("forwards only the fork fields the backend accepts", () => {
		const body = forkBody({
			checkpoint_id: "c1",
			fork_model: "m",
			fork_api_key: "sk-test-0000",
			extra: "x",
		});
		expect(body).toEqual({ checkpoint_id: "c1", fork_model: "m" });
	});

	it("drops values that are not strings and survives a non-object", () => {
		expect(forkBody({ checkpoint_id: 3, fork_provider: null })).toEqual({});
		expect(forkBody(undefined)).toEqual({});
	});
});
