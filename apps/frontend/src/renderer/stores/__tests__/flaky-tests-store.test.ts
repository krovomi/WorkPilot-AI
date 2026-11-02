/**
 * The flaky tests store: progress events become the run list, and what the
 * runner says after a cancel does not turn the page red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlakyTestsStore } from "../flaky-tests-store";

const api = {
	runFlakyTestsScan: vi.fn(),
	detectFlakyTestCommands: vi.fn(),
	cancelFlakyTestsScan: vi.fn(),
};
const INITIAL = useFlakyTestsStore.getState();

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.cancelFlakyTestsScan.mockResolvedValue(true);
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useFlakyTestsStore.setState(INITIAL, true);
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("flaky tests store", () => {
	it("records each finished run from the progress events", () => {
		useFlakyTestsStore.setState({ phase: "scanning" });
		const { applyEvent } = useFlakyTestsStore.getState();
		applyEvent({
			type: "start",
			data: { code: "running", command: "dotnet test", runs: 3, status: "x" },
		});
		applyEvent({
			type: "progress",
			data: {
				code: "run_finished",
				run: 1,
				runs: 3,
				passed: 10,
				failed: 1,
				exitCode: 1,
				timedOut: false,
				durationS: 4.2,
			},
		});
		const { activity, status } = useFlakyTestsStore.getState();
		expect(status).toBe("x");
		expect(activity.command).toBe("dotnet test");
		expect(activity.finished).toEqual([
			{ run: 1, passed: 10, failed: 1, exitCode: 1, timedOut: false, durationS: 4.2 },
		]);
	});

	it("ignores the error and the result that follow a cancel", async () => {
		let reject: (err: Error) => void = () => undefined;
		api.runFlakyTestsScan.mockReturnValue(
			new Promise((_resolve, rej) => {
				reject = rej;
			}),
		);
		const running = useFlakyTestsStore.getState().startRuns("/p");
		await useFlakyTestsStore.getState().cancelScan();
		useFlakyTestsStore.getState().setError("exited with code 143");
		reject(new Error("exited with code 143"));
		await running;
		expect(useFlakyTestsStore.getState().phase).toBe("idle");
		expect(useFlakyTestsStore.getState().error).toBeNull();
	});

	it("keeps the chosen command when it is still detected", async () => {
		api.detectFlakyTestCommands.mockResolvedValue({
			commands: [
				{ id: "vitest", label: "Vitest", command: "npx vitest run" },
				{ id: "pytest", label: "pytest", command: "python3 -m pytest" },
			],
			remote: false,
		});
		useFlakyTestsStore.setState({ commandId: "pytest" });
		await useFlakyTestsStore.getState().detectCommands("/p");
		expect(useFlakyTestsStore.getState().commandId).toBe("pytest");
		useFlakyTestsStore.setState({ commandId: "go" });
		await useFlakyTestsStore.getState().detectCommands("/p");
		expect(useFlakyTestsStore.getState().commandId).toBe("vitest");
		expect(useFlakyTestsStore.getState().detectedFor).toBe("/p");
	});

	it("sends a scan without run options", async () => {
		api.runFlakyTestsScan.mockResolvedValue({
			totalTests: 0,
			flakyCount: 0,
			flakyTests: [],
			summary: "",
		});
		await useFlakyTestsStore.getState().startScan("/p");
		expect(api.runFlakyTestsScan).toHaveBeenCalledWith({ projectPath: "/p", mode: "scan" });
		expect(useFlakyTestsStore.getState().phase).toBe("complete");
	});
});
