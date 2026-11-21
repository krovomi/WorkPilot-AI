/**
 * The floating panel of model downloads: what is running, what finished, what
 * failed, and the actions on each — in the app's language.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import {
	type DownloadProgress,
	initDownloadProgressListener,
	useDownloadStore,
} from "../../stores/download-store";
import { GlobalDownloadIndicator } from "../GlobalDownloadIndicator";

type ProgressPayload = {
	modelName: string;
	status: string;
	completed: number;
	total: number;
	percentage: number;
	error?: string;
};

const MB = 1024 * 1024;
let emit: ((data: ProgressPayload) => void) | undefined;
let api: Record<string, ReturnType<typeof vi.fn>>;
const originalApi = globalThis.electronAPI;

function seed(...downloads: DownloadProgress[]) {
	useDownloadStore.setState({
		downloads: Object.fromEntries(downloads.map((d) => [d.modelName, d])),
	});
}

const toggle = () => screen.getByRole("button", { name: "Toggle download details" });

describe("GlobalDownloadIndicator", () => {
	beforeEach(async () => {
		emit = undefined;
		api = {
			onDownloadProgress: vi.fn((cb: (data: ProgressPayload) => void) => {
				emit = cb;
				return () => undefined;
			}),
			getActiveOllamaPulls: vi.fn(async () => ({ success: true, data: { models: [] } })),
			ensureOllama: vi.fn(async () => ({ success: true })),
			pullOllamaModel: vi.fn(async () => ({ success: true })),
			cancelOllamaPull: vi.fn(async () => ({ success: true })),
		};
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
		useDownloadStore.setState({ downloads: {} });
		await i18n.changeLanguage("en");
	});

	afterEach(async () => {
		vi.useRealTimers();
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = originalApi;
		await act(() => i18n.changeLanguage("en"));
	});

	it("shows nothing while nothing downloads", () => {
		const { container } = render(<GlobalDownloadIndicator />);
		expect(container.childElementCount).toBe(0);
	});

	it("shows a starting download, and cancels it", () => {
		seed({ modelName: "llama3", status: "starting", percentage: 0 });
		render(<GlobalDownloadIndicator />);

		expect(screen.getByText("Downloading 1 model")).toBeTruthy();
		expect(screen.getByText("Starting...")).toBeTruthy();
		expect(
			screen.getByText("Downloads keep running in the background, even if you close this task."),
		).toBeTruthy();
		// Nothing to clear while something runs.
		expect(screen.queryByRole("button", { name: "Clear all completed downloads" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Cancel this download" }));
		expect(api.cancelOllamaPull).toHaveBeenCalledWith("llama3");
		// The header and the row both say it.
		expect(screen.getAllByText("Cancelled")).toHaveLength(2);
		expect(screen.queryByText("Starting...")).toBeNull();
	});

	it("follows progress from the main process, with speed and time left in words", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
		const stop = initDownloadProgressListener();
		render(<GlobalDownloadIndicator />);
		const base = { modelName: "qwen3", status: "downloading", total: 1000 * MB };

		act(() => emit?.({ ...base, completed: 0, percentage: 0 }));
		expect(screen.getByText("Starting...")).toBeTruthy();

		vi.setSystemTime(new Date("2026-11-20T12:00:01Z"));
		act(() => emit?.({ ...base, completed: 10 * MB, percentage: 1 }));
		expect(screen.getByText("Downloading 1 model")).toBeTruthy();
		expect(screen.getByText("1%")).toBeTruthy();
		expect(screen.getByText("10.0 MB/s")).toBeTruthy();
		// 990 MB at 10 MB/s: 99 s.
		expect(screen.getByText("2m remaining")).toBeTruthy();

		await act(() => i18n.changeLanguage("fr"));
		expect(screen.getByText("encore 2 min")).toBeTruthy();
		await act(() => i18n.changeLanguage("en"));

		act(() => emit?.({ ...base, status: "completed", completed: 1000 * MB, percentage: 100 }));
		expect(screen.getByText("1 download complete")).toBeTruthy();
		expect(screen.getByText("Done")).toBeTruthy();
		stop();
	});

	it("words hours and seconds left, and a speed with no estimate", () => {
		seed(
			{ modelName: "big", status: "downloading", percentage: 3, secondsRemaining: 5000 },
			{ modelName: "small", status: "downloading", percentage: 97, secondsRemaining: 42 },
			{ modelName: "steady", status: "downloading", percentage: 50, speed: "3.0 MB/s" },
		);
		render(<GlobalDownloadIndicator />);
		expect(screen.getByText("Downloading 3 models")).toBeTruthy();
		expect(screen.getByText("2h remaining")).toBeTruthy();
		expect(screen.getByText("42s remaining")).toBeTruthy();
		expect(screen.getByText("3.0 MB/s")).toBeTruthy();
		expect(screen.getByText("97%")).toBeTruthy();
	});

	it("puts a failure in the header, shows why, and retries it", async () => {
		seed(
			{ modelName: "llama3", status: "completed", percentage: 100 },
			{ modelName: "mistral", status: "failed", percentage: 40, error: "disk full" },
		);
		render(<GlobalDownloadIndicator />);

		// Not "1 download complete" next to a red icon.
		expect(screen.getByText("1 download failed")).toBeTruthy();
		expect(screen.getByText("Done")).toBeTruthy();
		expect(screen.getByText("Failed")).toBeTruthy();
		expect(screen.getByText("disk full")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(api.pullOllamaModel).toHaveBeenCalledWith("mistral", undefined));
		await waitFor(() => expect(screen.getAllByText("Done")).toHaveLength(2));
		expect(screen.getByText("2 downloads complete")).toBeTruthy();
	});

	it("shows a failure without a message", () => {
		seed({ modelName: "mistral", status: "failed", percentage: 0, error: "" });
		render(<GlobalDownloadIndicator />);
		expect(screen.getByText("1 download failed")).toBeTruthy();
		const row = screen.getByText("mistral").parentElement?.parentElement as HTMLElement;
		expect(row.querySelectorAll("p")).toHaveLength(0);
	});

	it("clears every finished download at once, with a button of its own", () => {
		seed(
			{ modelName: "llama3", status: "completed", percentage: 100 },
			{ modelName: "mistral", status: "cancelled", percentage: 10 },
		);
		const { container } = render(<GlobalDownloadIndicator />);
		const clear = screen.getByRole("button", { name: "Clear all completed downloads" });
		// A button inside a button is invalid HTML and swallows the inner one's role.
		expect(toggle().contains(clear)).toBe(false);

		fireEvent.click(clear);
		expect(useDownloadStore.getState().downloads).toEqual({});
		expect(container.childElementCount).toBe(0);
	});

	it("collapses to the header and opens again", () => {
		seed({ modelName: "llama3", status: "cancelled", percentage: 0 });
		render(<GlobalDownloadIndicator />);
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("llama3")).toBeTruthy();

		fireEvent.click(toggle());
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("llama3")).toBeNull();
		expect(within(toggle()).getByText("Cancelled")).toBeTruthy();

		fireEvent.click(toggle());
		expect(screen.getByText("llama3")).toBeTruthy();
	});
});
