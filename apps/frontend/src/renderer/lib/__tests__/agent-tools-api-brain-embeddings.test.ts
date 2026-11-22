import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchBrainEmbeddingsFound } from "../agent-tools-api";

const request = vi.fn();

beforeEach(() => {
	request.mockReset();
	vi.stubGlobal("electronAPI", { localBackendRequest: request });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

it("asks the brain which local embeddings model a sync would use", async () => {
	const found = { provider: "lm-studio", model: "text-embedding-bge-m3" };
	request.mockResolvedValue({
		status: 200,
		contentType: "application/json",
		text: JSON.stringify({ success: true, found }),
	});

	const res = await fetchBrainEmbeddingsFound();

	expect(res).toEqual({ ok: true, data: { success: true, found } });
	expect(request.mock.calls[0][0]).toMatchObject({
		method: "GET",
		url: expect.stringMatching(/^\/api\/brain\/settings\/embeddings\?/),
	});
});
