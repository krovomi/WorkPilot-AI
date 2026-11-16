/**
 * The recorder store (#387): steps upserted by id, a removed step stays
 * removed, an export sends the ids kept and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordedStep, RecorderEvent } from "../../../shared/types/browser-recorder";
import { setupBrowserRecorderListeners, useBrowserRecorderStore } from "../browser-recorder-store";

const api = {
	startBrowserRecording: vi.fn(),
	stopBrowserRecording: vi.fn(),
	exportBrowserRecording: vi.fn(),
	onBrowserRecorderEvent: vi.fn(),
};

const click = (id: string, value = "Go"): RecordedStep => ({
	id,
	kind: "click",
	selectors: [{ strategy: "text", value }],
});

const initial = useBrowserRecorderStore.getState();

beforeEach(() => {
	vi.clearAllMocks();
	useBrowserRecorderStore.setState(initial, true);
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
});

const store = () => useBrowserRecorderStore.getState();

describe("browser recorder store", () => {
	it("follows the session's events", () => {
		store().handleEvent({ type: "started", url: "http://a.test/" });
		expect(store().status).toBe("recording");
		store().handleEvent({ type: "step", step: click("s1") });
		store().handleEvent({ type: "step", step: click("s2") });
		store().handleEvent({ type: "step", step: click("s1", "Again") });
		expect(store().steps.map((s) => s.selectors[0].value)).toEqual(["Again", "Go"]);

		store().removeStep("s2");
		store().handleEvent({ type: "step", step: click("s2", "Late") });
		expect(store().steps.map((s) => s.id)).toEqual(["s1"]);

		store().handleEvent({ type: "stopped", reason: "closed", truncated: true });
		expect(store()).toMatchObject({ status: "idle", truncated: true });
		store().handleEvent({ type: "error", message: "No display" });
		expect(store().error).toBe("No display");
	});

	it("starts a fresh recording, or says why it could not", async () => {
		useBrowserRecorderStore.setState({ steps: [click("s1")], removed: ["s9"] });
		api.startBrowserRecording.mockResolvedValueOnce({ success: true });
		await store().start("/p", "http://a.test");
		expect(api.startBrowserRecording).toHaveBeenCalledWith("/p", "http://a.test");
		expect(store()).toMatchObject({ status: "starting", steps: [], removed: [] });

		api.startBrowserRecording.mockResolvedValueOnce({ success: false, error: "busy" });
		await store().start("/p", "http://a.test");
		expect(store()).toMatchObject({ status: "idle", error: "busy" });
		api.startBrowserRecording.mockResolvedValueOnce({ success: false });
		await store().start("/p", "http://a.test");
		expect(store().error).toBeNull();
		api.startBrowserRecording.mockRejectedValueOnce(new Error("gone"));
		await store().start("/p", "http://a.test");
		expect(store().error).toBe("gone");
		api.startBrowserRecording.mockRejectedValueOnce("odd");
		await store().start("/p", "http://a.test");
		expect(store().error).toBe("odd");
	});

	it("stops, and falls back to idle when nothing was running", async () => {
		useBrowserRecorderStore.setState({ status: "recording" });
		api.stopBrowserRecording.mockResolvedValueOnce({ success: true });
		await store().stop();
		expect(store().status).toBe("stopping");
		api.stopBrowserRecording.mockResolvedValueOnce({ success: false });
		await store().stop();
		expect(store().status).toBe("idle");
	});

	it("exports the kept ids in the chosen format", async () => {
		useBrowserRecorderStore.setState({ steps: [click("s3"), click("s1")] });
		store().setFormat("cypress");
		store().setName("Log in");
		const outcome = { success: true, code: "cy.visit()" };
		api.exportBrowserRecording.mockResolvedValueOnce(outcome);
		await store().exportTo("/p", "preview");
		expect(api.exportBrowserRecording).toHaveBeenCalledWith("/p", {
			format: "cypress",
			destination: "preview",
			name: "Log in",
			stepIds: ["s3", "s1"],
		});
		expect(store()).toMatchObject({ outcome, exporting: null });

		api.exportBrowserRecording.mockResolvedValueOnce({ success: false, error: "no card" });
		await store().exportTo("/p", "review");
		expect(store()).toMatchObject({ outcome: null, error: "no card" });
		api.exportBrowserRecording.mockResolvedValueOnce({ success: false });
		await store().exportTo("/p", "review");
		expect(store().error).toBeNull();
		api.exportBrowserRecording.mockRejectedValueOnce(new Error("crash"));
		await store().exportTo("/p", "file");
		expect(store()).toMatchObject({ error: "crash", exporting: null });
	});

	it("hears the main process once, through the global listeners", () => {
		const teardown = vi.fn();
		api.onBrowserRecorderEvent.mockReturnValueOnce(teardown);
		expect(setupBrowserRecorderListeners()).toBe(teardown);
		const [[callback]] = api.onBrowserRecorderEvent.mock.calls as [[(event: RecorderEvent) => void]];
		callback({ type: "started", url: "http://a.test/" });
		expect(store().status).toBe("recording");
	});
});
