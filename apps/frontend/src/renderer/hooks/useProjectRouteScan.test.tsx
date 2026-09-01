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
});
