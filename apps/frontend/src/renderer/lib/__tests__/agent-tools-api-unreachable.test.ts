import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHermesStatus, runHermesCycle } from "../agent-tools-api";

const request = vi.fn();

beforeEach(() => {
	request.mockReset();
	vi.stubGlobal("electronAPI", { localBackendRequest: request });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a local backend that did not answer", () => {
	it("is reported as unreachable, on a GET and on a POST", async () => {
		request.mockResolvedValue({ unreachable: true });
		expect(await fetchHermesStatus()).toMatchObject({ ok: false, unreachable: true });
		expect(await runHermesCycle("kanban")).toMatchObject({ ok: false, unreachable: true });
	});

	it("is not confused with an answer that is not JSON", async () => {
		request.mockResolvedValueOnce({ status: 200, contentType: "text/html", text: "<html>" });
		const res = await fetchHermesStatus();
		expect(res.ok).toBe(false);
		expect(res).not.toHaveProperty("unreachable");
	});
});
