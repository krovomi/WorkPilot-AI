import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApiExplorerStore } from "../stores/api-explorer-store";
import { useProjectStore } from "../stores/project-store";
import { useProjectRouteScan } from "./useProjectRouteScan";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const spec = (title: string) => ({
	openapi: "3.0.0",
	info: { title, version: "1" },
	paths: {},
});

describe("useProjectRouteScan", () => {
	beforeEach(() => {
		useApiExplorerStore.setState({
			spec: null,
			specSource: null,
			scannedProjectId: null,
			isProjectScanning: false,
			projectScanError: null,
		});
		useProjectStore.setState({
			projects: [
				{ id: "workpilot", path: "C:/workpilot", name: "WorkPilot" },
				{ id: "test", path: "C:/test", name: "test" },
			] as never,
			activeProjectId: "workpilot",
			selectedProjectId: "workpilot",
		});
	});

	it("ignores an older scan that finishes after the active project changed", async () => {
		const oldScan = deferred<{ success: boolean; data: ReturnType<typeof spec> }>();
		const newScan = deferred<{ success: boolean; data: ReturnType<typeof spec> }>();
		const scanProjectRoutes = vi
			.fn()
			.mockReturnValueOnce(oldScan.promise)
			.mockReturnValueOnce(newScan.promise);
		Object.assign(window.electronAPI, { scanProjectRoutes });

		renderHook(() => useProjectRouteScan());
		act(() => useProjectStore.getState().setActiveProject("test"));

		await act(async () => {
			newScan.resolve({ success: true, data: spec("test") });
			await newScan.promise;
		});
		await act(async () => {
			oldScan.resolve({ success: true, data: spec("WorkPilot") });
			await oldScan.promise;
		});

		expect(useApiExplorerStore.getState().spec?.info.title).toBe("test");
		expect(useApiExplorerStore.getState().scannedProjectId).toBe("test");
	});

	it("keeps source-discovered endpoints when live OpenAPI URLs are unavailable", async () => {
		const scanned = spec("Scanned .NET API");
		const scanProjectRoutes = vi.fn().mockResolvedValue({
			success: true,
			data: scanned,
			specUrls: ["http://localhost:5180/swagger/v1/swagger.json"],
		});
		// Nothing is listening — the ordinary case, reported as an absence of
		// document rather than as a failure.
		const probeLiveApiSpec = vi.fn().mockResolvedValue({
			success: true,
			data: null,
		});
		Object.assign(window.electronAPI, { scanProjectRoutes, probeLiveApiSpec });

		renderHook(() => useProjectRouteScan());
		await act(async () => await Promise.resolve());
		await act(async () => await Promise.resolve());

		expect(useApiExplorerStore.getState().spec).toEqual(scanned);
		expect(useApiExplorerStore.getState().specSource).toBe("scan");
		expect(useApiExplorerStore.getState().specError).toBeNull();
	});

	it("prefers a live OpenAPI document discovered from the project profile", async () => {
		const live = spec("Live .NET API");
		const discoveredUrl = "http://localhost:5180/swagger/v1/swagger.json";
		const scanProjectRoutes = vi.fn().mockResolvedValue({
			success: true,
			data: spec("Scanned .NET API"),
			specUrls: [discoveredUrl],
		});
		const probeLiveApiSpec = vi.fn().mockResolvedValue({
			success: true,
			data: live,
			url: discoveredUrl,
		});
		Object.assign(window.electronAPI, { scanProjectRoutes, probeLiveApiSpec });

		renderHook(() => useProjectRouteScan());
		await act(async () => await Promise.resolve());
		await act(async () => await Promise.resolve());

		expect(useApiExplorerStore.getState().spec).toEqual(live);
		expect(useApiExplorerStore.getState().specSource).toBe("url");
		expect(useApiExplorerStore.getState().specUrl).toBe(discoveredUrl);
	});
});
