/**
 * The browser agent's dashboard: screenshots, baselines and comparisons, the
 * E2E test run, and the preview of the last capture. Every refusal from the
 * main process is shown, and a capture always ends.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserAgentStore } from "../browser-agent-store";

const INITIAL = useBrowserAgentStore.getState();
const state = () => useBrowserAgentStore.getState();
const invoke = vi.fn();
const dashboard = {
	stats: { totalTests: 4, passRate: 75, screenshotsCaptured: 2, regressionsDetected: 1 },
	screenshots: [{ name: "home" }],
	baselines: [{ name: "home" }],
	comparisons: [{ name: "home", passed: true }],
	recentTestRun: { passed: 3 },
};

beforeEach(() => {
	useBrowserAgentStore.setState(INITIAL, true);
	invoke.mockReset().mockImplementation(async (channel: string) => {
		switch (channel) {
			case "browserAgent:getDashboard":
				return { success: true, data: dashboard };
			case "browserAgent:captureScreenshot":
				return { success: true, data: { path: "/shots/home.png" } };
			case "browserAgent:getScreenshotImage":
				return { success: true, data: { mimeType: "image/png", base64: "AAAA" } };
			case "browserAgent:compare":
				return { success: true, data: { name: "home", passed: false } };
			case "browserAgent:runTests":
				return { success: true, data: { passed: 4 } };
			default:
				return { success: true };
		}
	});
	(window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
});

describe("the dashboard", () => {
	it("loads its data", async () => {
		await state().fetchDashboard("/p");
		expect(invoke).toHaveBeenCalledWith("browserAgent:getDashboard", "/p");
		expect(state()).toMatchObject({ ...dashboard, isLoading: false, error: null });
	});

	it("reads missing parts as empty, and keeps what it had when nothing comes back", async () => {
		state().setDashboardData({} as never);
		expect(state()).toMatchObject({ stats: { totalTests: 0 }, screenshots: [], baselines: [], comparisons: [], recentTestRun: null });
		state().setDashboardData(dashboard as never);
		invoke.mockResolvedValueOnce({ success: false });
		await state().fetchDashboard("/p");
		expect(state().screenshots).toEqual(dashboard.screenshots);
		invoke.mockRejectedValueOnce(new Error("no runner"));
		await state().fetchDashboard("/p");
		expect(state()).toMatchObject({ error: "Error: no runner", isLoading: false });
	});

	it("keeps the page's own choices", () => {
		state().setActiveTab("tests" as never);
		state().setLoading(true);
		state().setError("e");
		state().setCurrentUrl("http://localhost:3000");
		state().setBrowserStatus("ready");
		state().setBrowserScreenshot("data:x");
		expect(state()).toMatchObject({
			activeTab: "tests",
			isLoading: true,
			error: "e",
			currentUrl: "http://localhost:3000",
			browserStatus: "ready",
			browserScreenshot: "data:x",
		});
	});
});

describe("capturing a screenshot", () => {
	it("captures, reloads the dashboard and shows the capture", async () => {
		const pending = state().captureScreenshot("/p", "home", "http://localhost:3000");
		expect(state()).toMatchObject({ isCapturing: true, browserStatus: "navigating" });
		await pending;
		expect(invoke).toHaveBeenCalledWith("browserAgent:captureScreenshot", "/p", "home", "http://localhost:3000");
		expect(invoke).toHaveBeenCalledWith("browserAgent:getScreenshotImage", "/shots/home.png");
		expect(state()).toMatchObject({ isCapturing: false, browserStatus: "ready", browserScreenshot: "data:image/png;base64,AAAA", screenshots: dashboard.screenshots });
	});

	it("ends the capture even when its preview cannot be read", async () => {
		state().setBrowserScreenshot("data:previous");
		invoke.mockImplementation(async (channel: string) =>
			channel === "browserAgent:getScreenshotImage" ? { success: false } : { success: true, data: { path: "/x.png" } },
		);
		await state().captureScreenshot("/p", "home", "u");
		expect(state()).toMatchObject({ browserStatus: "ready", browserScreenshot: "data:previous", isCapturing: false });

		invoke.mockImplementation(async (channel: string) => {
			if (channel === "browserAgent:getScreenshotImage") throw new Error("gone");
			return { success: true, data: { path: "/x.png" } };
		});
		await state().captureScreenshot("/p", "home", "u");
		expect(state().browserStatus).toBe("ready");
	});

	it("says why the capture failed", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "browser not installed" });
		await state().captureScreenshot("/p", "home", "u");
		expect(state()).toMatchObject({ error: "browser not installed", browserStatus: "error", isCapturing: false });
		invoke.mockResolvedValueOnce(null);
		await state().captureScreenshot("/p", "home", "u");
		expect(state().error).toBe("Screenshot capture failed");
		invoke.mockRejectedValueOnce(new Error("crash"));
		await state().captureScreenshot("/p", "home", "u");
		expect(state()).toMatchObject({ error: "Error: crash", browserStatus: "error" });
	});
});

describe("baselines", () => {
	it("sets one from a capture and reloads the dashboard", async () => {
		await state().setBaseline("/p", "home", "/shots/home.png");
		expect(invoke).toHaveBeenCalledWith("browserAgent:setBaseline", "/p", "home", "/shots/home.png");
		expect(invoke).toHaveBeenCalledWith("browserAgent:getDashboard", "/p");
		expect(state().isLoading).toBe(false);
	});

	it("deletes one and reloads the dashboard", async () => {
		await state().deleteBaseline("/p", "home");
		expect(invoke).toHaveBeenCalledWith("browserAgent:deleteBaseline", "/p", "home");
		expect(invoke).toHaveBeenCalledWith("browserAgent:getDashboard", "/p");
	});

	it("says why a baseline could not be set or deleted", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "no screenshot" });
		await state().setBaseline("/p", "home");
		expect(state().error).toBe("no screenshot");
		invoke.mockResolvedValueOnce(undefined);
		await state().setBaseline("/p", "home");
		expect(state().error).toBe("Failed to set baseline");
		invoke.mockRejectedValueOnce(new Error("x"));
		await state().setBaseline("/p", "home");
		expect(state()).toMatchObject({ error: "Error: x", isLoading: false });

		invoke.mockResolvedValueOnce({ success: false, data: { deleted: false } });
		await state().deleteBaseline("/p", "home");
		expect(state().error).toBe("Failed to delete baseline");
		invoke.mockResolvedValueOnce({ success: false, error: "locked" });
		await state().deleteBaseline("/p", "home");
		expect(state().error).toBe("locked");
		invoke.mockRejectedValueOnce(new Error("y"));
		await state().deleteBaseline("/p", "home");
		expect(state()).toMatchObject({ error: "Error: y", isLoading: false });
		expect(invoke).not.toHaveBeenCalledWith("browserAgent:getDashboard", "/p");
	});
});

describe("comparisons and tests", () => {
	it("puts the latest comparison of a screen first, replacing its last one", async () => {
		useBrowserAgentStore.setState({ comparisons: [{ name: "about" }, { name: "home", passed: true }] as never });
		await state().compareScreenshot("/p", "home", "http://localhost:3000");
		expect(invoke).toHaveBeenCalledWith("browserAgent:compare", "/p", "home", "http://localhost:3000");
		expect(state().comparisons).toEqual([{ name: "home", passed: false }, { name: "about" }]);
		expect(state().isComparing).toBe(false);
	});

	it("runs the E2E tests", async () => {
		await state().runTests("/p");
		expect(state()).toMatchObject({ recentTestRun: { passed: 4 }, isRunningTests: false });
	});

	it("says why a comparison or a test run failed", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "no baseline" });
		await state().compareScreenshot("/p", "home");
		expect(state().error).toBe("no baseline");
		invoke.mockResolvedValueOnce({ success: true });
		await state().compareScreenshot("/p", "home");
		expect(state().error).toBe("Comparison failed");
		invoke.mockRejectedValueOnce(new Error("x"));
		await state().compareScreenshot("/p", "home");
		expect(state()).toMatchObject({ error: "Error: x", isComparing: false });

		invoke.mockResolvedValueOnce({ success: false, error: "no tests" });
		await state().runTests("/p");
		expect(state().error).toBe("no tests");
		invoke.mockResolvedValueOnce(null);
		await state().runTests("/p");
		expect(state().error).toBe("Test run failed");
		invoke.mockRejectedValueOnce(new Error("y"));
		await state().runTests("/p");
		expect(state()).toMatchObject({ error: "Error: y", isRunningTests: false });
	});
});
