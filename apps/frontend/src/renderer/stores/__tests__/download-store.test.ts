/**
 * Tests for the model-download store.
 *
 * The store is what makes a multi-gigabyte pull tolerable: the download runs in
 * the main process, so closing the task panel, switching view or reloading the
 * window must not lose it, and every window has to render the same download
 * whichever one started it. Both of those are properties of THIS file — the
 * upsert on progress, the terminal events, and the rehydrate — so they are
 * pinned here.
 */

import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	initDownloadProgressListener,
	useDownloadStore,
} from "../download-store";

type ProgressPayload = {
	modelName: string;
	status: string;
	completed: number;
	total: number;
	percentage: number;
	error?: string;
};

/** Captures the callback `initDownloadProgressListener` registers. */
function installFakeBridge(activePulls: string[] = []) {
	let emit: ((data: ProgressPayload) => void) | undefined;
	const api = {
		onDownloadProgress: vi.fn((cb: (data: ProgressPayload) => void) => {
			emit = cb;
			return () => {
				emit = undefined;
			};
		}),
		getActiveOllamaPulls: vi.fn(async () => ({
			success: true as const,
			data: { models: activePulls },
		})),
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal bridge stub for the test
	(window as any).electronAPI = api;
	return {
		api,
		emit: (data: ProgressPayload) => emit?.(data),
	};
}

beforeEach(() => {
	useDownloadStore.setState({ downloads: {} });
	// biome-ignore lint/suspicious/noExplicitAny: reset the bridge between tests
	(window as any).electronAPI = undefined;
});

describe("download store", () => {
	it("upserts progress for a download it never started", () => {
		// The pull was started from another view (settings, onboarding) and the
		// main process broadcasts to every window. Dropping the event — which the
		// old update-only implementation did — left the model looking idle.
		const { emit } = installFakeBridge();
		const cleanup = initDownloadProgressListener();

		act(() => {
			emit({
				modelName: "llama3.3",
				status: "downloading",
				completed: 50,
				total: 100,
				percentage: 50,
			});
		});

		const entry = useDownloadStore.getState().downloads["llama3.3"];
		expect(entry?.status).toBe("downloading");
		expect(entry?.percentage).toBe(50);
		cleanup();
	});

	it("settles on the terminal completed event", () => {
		// Only the window that invoked the pull holds its promise. Without a
		// terminal broadcast the others would spin on a download that finished.
		const { emit } = installFakeBridge();
		const cleanup = initDownloadProgressListener();

		act(() => {
			useDownloadStore.getState().startDownload("llama3.3");
			emit({
				modelName: "llama3.3",
				status: "completed",
				completed: 0,
				total: 0,
				percentage: 100,
			});
		});

		const entry = useDownloadStore.getState().downloads["llama3.3"];
		expect(entry?.status).toBe("completed");
		expect(entry?.percentage).toBe(100);
		expect(useDownloadStore.getState().hasActiveDownloads()).toBe(false);
		cleanup();
	});

	it("records a failure with its reason", () => {
		const { emit } = installFakeBridge();
		const cleanup = initDownloadProgressListener();

		act(() => {
			useDownloadStore.getState().startDownload("llama3.3");
			emit({
				modelName: "llama3.3",
				status: "failed",
				completed: 0,
				total: 0,
				percentage: 0,
				error: "no space left on device",
			});
		});

		const entry = useDownloadStore.getState().downloads["llama3.3"];
		expect(entry?.status).toBe("failed");
		expect(entry?.error).toBe("no space left on device");
		cleanup();
	});

	it("treats a cancellation as the user's decision, not a failure", () => {
		// A cancelled pull must not raise an error toast or a red row: the user
		// stopped it on purpose and already knows.
		const { emit } = installFakeBridge();
		const cleanup = initDownloadProgressListener();

		act(() => {
			useDownloadStore.getState().startDownload("llama3.3");
			emit({
				modelName: "llama3.3",
				status: "failed",
				completed: 0,
				total: 0,
				percentage: 0,
				error: "PULL_CANCELLED",
			});
		});

		const entry = useDownloadStore.getState().downloads["llama3.3"];
		expect(entry?.status).toBe("cancelled");
		expect(entry?.error).toBeUndefined();
		cleanup();
	});

	it("adopts downloads already running in the main process", async () => {
		// A pull outlives the view that started it. A freshly mounted renderer
		// must learn about it instead of showing the model as "to download"
		// while it is already at 60%.
		installFakeBridge(["qwen2.5-coder"]);

		await act(async () => {
			await useDownloadStore.getState().rehydrate();
		});

		expect(useDownloadStore.getState().isDownloading("qwen2.5-coder")).toBe(
			true,
		);
	});

	it("does not overwrite live progress when rehydrating", async () => {
		installFakeBridge(["qwen2.5-coder"]);
		act(() => {
			useDownloadStore.getState().updateProgress("qwen2.5-coder", {
				percentage: 60,
			});
		});

		await act(async () => {
			await useDownloadStore.getState().rehydrate();
		});

		expect(
			useDownloadStore.getState().downloads["qwen2.5-coder"]?.percentage,
		).toBe(60);
	});

	it("reports a model as downloading only while it is in flight", () => {
		const store = useDownloadStore.getState();
		act(() => store.startDownload("gemma3"));
		expect(useDownloadStore.getState().isDownloading("gemma3")).toBe(true);

		act(() => useDownloadStore.getState().completeDownload("gemma3"));
		expect(useDownloadStore.getState().isDownloading("gemma3")).toBe(false);
	});
});
