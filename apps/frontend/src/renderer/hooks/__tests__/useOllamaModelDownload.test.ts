/**
 * Tests for the model-download hook.
 *
 * The properties pinned here are the ones the user actually feels: the pull is
 * sent to the server the run will use (not silently to localhost), a second
 * request does not start a second multi-gigabyte download, a cancellation is
 * not reported as a failure, and a completed pull tells the caller so its model
 * list can flip from "à télécharger" to "✓ installé".
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
vi.mock("../use-toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback?: string) => fallback ?? "",
	}),
}));

const settings: { globalOllamaApiUrl?: string } = {};
vi.mock("../../stores/settings-store", () => ({
	useSettingsStore: (selector: (s: unknown) => unknown) =>
		selector({ settings }),
}));

import { useDownloadStore } from "../../stores/download-store";
import { useOllamaModelDownload } from "../useOllamaModelDownload";

const pullOllamaModel = vi.fn();
const ensureOllama = vi.fn();
const cancelOllamaPull = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	useDownloadStore.setState({ downloads: {} });
	settings.globalOllamaApiUrl = undefined;
	ensureOllama.mockResolvedValue({ success: true, data: {} });
	pullOllamaModel.mockResolvedValue({ success: true, data: {} });
	cancelOllamaPull.mockResolvedValue({ success: true });
	// biome-ignore lint/suspicious/noExplicitAny: minimal bridge stub for the test
	(globalThis as any).electronAPI = {
		pullOllamaModel,
		ensureOllama,
		cancelOllamaPull,
	};
});

describe("useOllamaModelDownload", () => {
	it("pulls onto the configured server, not the default one", async () => {
		// A pull sent to localhost while the run talks to a custom host lands the
		// model where nothing will look for it: "downloaded" and still missing.
		settings.globalOllamaApiUrl = "http://192.168.1.20:11434";
		const { result } = renderHook(() => useOllamaModelDownload());

		await act(async () => {
			await result.current.download("llama3.3");
		});

		expect(ensureOllama).toHaveBeenCalledWith("http://192.168.1.20:11434");
		expect(pullOllamaModel).toHaveBeenCalledWith(
			"llama3.3",
			"http://192.168.1.20:11434",
		);
	});

	it("falls back to the default server when none is configured", async () => {
		const { result } = renderHook(() => useOllamaModelDownload());

		await act(async () => {
			await result.current.download("llama3.3");
		});

		expect(pullOllamaModel).toHaveBeenCalledWith("llama3.3", undefined);
	});

	it("does not start a second download of the same model", async () => {
		// Clicking the chip twice, or re-picking the model in the dropdown while
		// it is downloading, must not double the bandwidth.
		const { result } = renderHook(() => useOllamaModelDownload());
		let release: (v: unknown) => void = () => {
			/* replaced by the promise executor below */
		};
		pullOllamaModel.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);

		act(() => {
			void result.current.download("llama3.3");
		});
		await act(async () => {
			await result.current.download("llama3.3");
		});

		expect(pullOllamaModel).toHaveBeenCalledTimes(1);
		await act(async () => release({ success: true, data: {} }));
	});

	it("notifies the caller when the model lands", async () => {
		// This is what flips the dropdown entry to "✓ installé" without a reload.
		const onDownloaded = vi.fn();
		const { result } = renderHook(() =>
			useOllamaModelDownload({ onDownloaded }),
		);

		await act(async () => {
			await result.current.download("llama3.3");
		});

		expect(onDownloaded).toHaveBeenCalledWith("llama3.3");
		expect(useDownloadStore.getState().downloads["llama3.3"]?.status).toBe(
			"completed",
		);
	});

	it("reports a failure with the reason the backend gave", async () => {
		pullOllamaModel.mockResolvedValue({
			success: false,
			error: "no space left on device",
		});
		const { result } = renderHook(() => useOllamaModelDownload());

		await act(async () => {
			await result.current.download("llama3.3");
		});

		const entry = useDownloadStore.getState().downloads["llama3.3"];
		expect(entry?.status).toBe("failed");
		expect(entry?.error).toBe("no space left on device");
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ variant: "destructive" }),
		);
	});

	it("stays quiet when the user cancelled it", async () => {
		// A cancellation is not a failure: the user already knows, and an error
		// toast for their own click is noise.
		pullOllamaModel.mockResolvedValue({
			success: false,
			error: "PULL_CANCELLED",
		});
		const { result } = renderHook(() => useOllamaModelDownload());

		await act(async () => {
			await result.current.download("llama3.3");
		});

		expect(useDownloadStore.getState().downloads["llama3.3"]?.status).toBe(
			"cancelled",
		);
		expect(toast).not.toHaveBeenCalledWith(
			expect.objectContaining({ variant: "destructive" }),
		);
	});

	it("does not attempt a pull when the server cannot be started", async () => {
		// "The download did not start" is a different problem from "the download
		// failed", and the fix (start Ollama) is different too.
		ensureOllama.mockResolvedValue({ success: false, error: "port in use" });
		const { result } = renderHook(() => useOllamaModelDownload());

		await act(async () => {
			await result.current.download("llama3.3");
		});

		expect(pullOllamaModel).not.toHaveBeenCalled();
		expect(useDownloadStore.getState().downloads["llama3.3"]?.error).toBe(
			"port in use",
		);
	});

	it("asks the main process to abort a running pull", async () => {
		const { result } = renderHook(() => useOllamaModelDownload());
		act(() => useDownloadStore.getState().startDownload("llama3.3"));

		act(() => result.current.cancel("llama3.3"));

		expect(cancelOllamaPull).toHaveBeenCalledWith("llama3.3");
		expect(useDownloadStore.getState().downloads["llama3.3"]?.status).toBe(
			"cancelled",
		);
	});
});
