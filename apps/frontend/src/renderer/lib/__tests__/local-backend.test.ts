import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localBackendFetch, localBackendObjectUrl } from "../local-backend";

const request = vi.fn();

beforeEach(() => {
	request.mockReset();
	vi.stubGlobal("electronAPI", { localBackendRequest: request });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("localBackendFetch", () => {
	it("asks main and reads the answer like a fetch Response", async () => {
		request.mockResolvedValueOnce({
			status: 200,
			contentType: "application/json",
			text: '{"success":true}',
		});
		const res = await localBackendFetch("/api/brain/status", { method: "POST", body: "{}" });
		expect(request).toHaveBeenCalledWith({ method: "POST", url: "/api/brain/status", body: "{}" });
		expect(res.ok).toBe(true);
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(await res.json()).toEqual({ success: true });
	});

	it("rejects like fetch when nothing answers", async () => {
		request.mockResolvedValueOnce({ unreachable: true });
		await expect(localBackendFetch("/api/rtk/status")).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects with an AbortError when the signal aborts", async () => {
		request.mockReturnValueOnce(new Promise(() => {}));
		const controller = new AbortController();
		const pending = localBackendFetch("/api/rtk/status", { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });

		const already = new AbortController();
		already.abort();
		await expect(localBackendFetch("/api/rtk/status", { signal: already.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("keeps a status without body", async () => {
		request.mockResolvedValueOnce({ status: 204, contentType: "", text: "" });
		const res = await localBackendFetch("/api/brain/status");
		expect(res.status).toBe(204);
	});
});

describe("localBackendObjectUrl", () => {
	it("turns the bytes main read into a blob URL, and a refusal into null", async () => {
		const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shot");
		request.mockResolvedValueOnce({
			status: 200,
			contentType: "image/png",
			bytes: new Uint8Array([1, 2]),
		});
		expect(await localBackendObjectUrl("/api/verify/screenshot?index=0")).toBe("blob:shot");
		expect(request).toHaveBeenCalledWith(expect.objectContaining({ binary: true }));
		expect(create).toHaveBeenCalledOnce();

		request.mockResolvedValueOnce({ status: 404, contentType: "application/json", text: "{}" });
		expect(await localBackendObjectUrl("/api/verify/screenshot?index=9")).toBeNull();
	});
});
