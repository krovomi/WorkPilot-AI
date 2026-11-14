import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalBackendFile } from "../useLocalBackendFile";

const request = vi.fn();

beforeEach(() => {
	request.mockReset();
	vi.stubGlobal("electronAPI", { localBackendRequest: request });
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:file");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useLocalBackendFile", () => {
	it("shows a backend file from a blob URL and releases it on unmount", async () => {
		request.mockResolvedValueOnce({ status: 200, contentType: "image/png", bytes: new Uint8Array([1]) });
		const { result, unmount } = renderHook(() => useLocalBackendFile("/api/verify/screenshot?index=0"));
		expect(result.current).toBeUndefined();
		await waitFor(() => expect(result.current).toBe("blob:file"));
		unmount();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
	});

	it("leaves a URL that is not a backend path as it is", () => {
		const { result } = renderHook(() => useLocalBackendFile("data:image/png;base64,AA=="));
		expect(result.current).toBe("data:image/png;base64,AA==");
		expect(request).not.toHaveBeenCalled();
	});

	it("shows nothing when the backend refuses the file", async () => {
		request.mockResolvedValueOnce({ status: 404, contentType: "application/json", text: "{}" });
		const { result } = renderHook(() => useLocalBackendFile("/api/verify/video"));
		await waitFor(() => expect(request).toHaveBeenCalled());
		expect(result.current).toBeUndefined();
	});
});
