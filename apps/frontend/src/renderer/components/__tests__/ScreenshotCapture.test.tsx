/**
 * The screenshot picker of the task form: the screens and windows the main
 * process offers, the capture of the one picked, what each failure says, and
 * the development build, which cannot capture and says how to paste instead.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { ScreenshotSource } from "../../../shared/types/screenshot";
import { ScreenshotCapture } from "../ScreenshotCapture";

const SOURCES: ScreenshotSource[] = [
	{ id: "screen:0:0", name: "Entire screen", thumbnail: "data:image/png;base64,AAAA" },
	// A window whose title says « display » is still a window
	{ id: "window:42:0", name: "Display settings", thumbnail: "" },
	{ id: "screen:1:0", name: "Screen 2", thumbnail: "" },
];

let getSources: ReturnType<typeof vi.fn>;
let capture: ReturnType<typeof vi.fn>;

function renderPicker(open = true) {
	const onOpenChange = vi.fn();
	const onCapture = vi.fn();
	const view = render(
		<ScreenshotCapture open={open} onOpenChange={onOpenChange} onCapture={onCapture} />,
	);
	return { onOpenChange, onCapture, ...view };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const captureButton = () => screen.getByRole("button", { name: "Capture" });
const refreshButton = () => screen.getByRole("button", { name: "Refresh" });

beforeEach(async () => {
	await i18n.changeLanguage("en");
	getSources = vi.fn().mockResolvedValue({ success: true, data: SOURCES });
	capture = vi.fn().mockResolvedValue({ success: true, data: "data:image/png;base64,FULL" });
	(globalThis as { electronAPI?: unknown }).electronAPI = { getSources, capture };
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	Reflect.deleteProperty(navigator, "userAgentData");
	vi.restoreAllMocks();
});

describe("ScreenshotCapture — sources", () => {
	it("asks for nothing while closed", () => {
		renderPicker(false);
		expect(getSources).not.toHaveBeenCalled();
	});

	it("tells screens from windows by what Electron says they are, not by their title", async () => {
		renderPicker();
		const entire = await screen.findByRole("button", { name: /Entire screen/ });
		expect(entire).toHaveAccessibleName("Screen Entire screen");
		expect(screen.getByRole("button", { name: /Display settings/ })).toHaveAccessibleName(
			"Window Display settings",
		);
		expect(screen.getByRole("button", { name: /Screen 2/ })).toHaveAccessibleName(
			"Screen Screen 2",
		);
		// The thumbnail is shown, as decoration: the name is written below it
		expect(entire.querySelector("img")).toHaveAttribute("src", SOURCES[0].thumbnail);
		expect(entire.querySelector("img")).toHaveAttribute("alt", "");
	});

	it("captures the source picked, hands the image over and closes", async () => {
		const { onCapture, onOpenChange } = renderPicker();
		expect(captureButton()).toBeDisabled();
		const window = await screen.findByRole("button", { name: /Display settings/ });
		expect(window).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(window);
		expect(window).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(captureButton());
		await waitFor(() => expect(onCapture).toHaveBeenCalledWith("data:image/png;base64,FULL"));
		expect(capture).toHaveBeenCalledWith({ sourceId: "window:42:0" });
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(window).toHaveAttribute("aria-pressed", "false");
	});

	it("shows the capture under way and keeps it from being cancelled midway", async () => {
		const pending = deferred<{ success: boolean; data?: string }>();
		capture.mockReturnValue(pending.promise);
		const { onCapture } = renderPicker();
		fireEvent.click(await screen.findByRole("button", { name: /Entire screen/ }));
		fireEvent.click(captureButton());
		expect(await screen.findByRole("button", { name: "Capturing..." })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		expect(refreshButton()).toBeDisabled();
		pending.resolve({ success: true, data: "img" });
		await waitFor(() => expect(onCapture).toHaveBeenCalledWith("img"));
	});

	it("cancels without capturing", async () => {
		const { onOpenChange, onCapture } = renderPicker();
		await screen.findByRole("button", { name: /Entire screen/ });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onCapture).not.toHaveBeenCalled();
	});

	it("reads the sources again on refresh, with a spinner meanwhile", async () => {
		renderPicker();
		fireEvent.click(await screen.findByRole("button", { name: /Entire screen/ }));
		const pending = deferred<{ success: boolean; data?: ScreenshotSource[] }>();
		getSources.mockReturnValue(pending.promise);
		fireEvent.click(refreshButton());
		expect(refreshButton()).toBeDisabled();
		expect(screen.queryByRole("button", { name: /Entire screen/ })).not.toBeInTheDocument();
		pending.resolve({ success: true, data: [SOURCES[2]] });
		expect(await screen.findByRole("button", { name: /Screen 2/ })).toBeInTheDocument();
		expect(getSources).toHaveBeenCalledTimes(2);
		// The selection made before the refresh is gone
		expect(captureButton()).toBeDisabled();
	});

	it("shows a spinner, then says when there is nothing to capture", async () => {
		const pending = deferred<{ success: boolean; data?: ScreenshotSource[] }>();
		getSources.mockReturnValueOnce(pending.promise);
		renderPicker();
		const dialog = screen.getByRole("dialog");
		expect(dialog.querySelector(".animate-spin")).not.toBeNull();
		pending.resolve({ success: true, data: [] });
		expect(await screen.findByText("No screens or windows found")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
		expect(await screen.findByRole("button", { name: /Entire screen/ })).toBeInTheDocument();
	});
});

describe("ScreenshotCapture — failures", () => {
	it.each([
		[{ success: false }, "Failed to get screenshot sources"],
		[{ success: true }, "Failed to get screenshot sources"],
		[
			{ success: false, error: "sources_failed" },
			"Failed to get screenshot sources\nThe screens and windows could not be listed. Check that the app is allowed to record the screen.",
		],
		// Only a code is shown: a sentence the main process might still send is not
		[{ success: false, error: "Screen recording is not allowed" }, "Failed to get screenshot sources"],
	])("says the sources could not be read (%j)", async (answer, message) => {
		getSources.mockResolvedValue(answer);
		renderPicker();
		expect((await screen.findByRole("alert")).textContent).toBe(message);
	});

	it("says so when reading the sources throws, then retries", async () => {
		getSources.mockRejectedValueOnce(new Error("IPC closed")).mockRejectedValueOnce("odd");
		renderPicker();
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Failed to fetch screenshot sources\nIPC closed",
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe("Failed to fetch screenshot sources"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByRole("button", { name: /Entire screen/ })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it.each([
		[
			{ success: false, error: "source_not_found" },
			"Failed to capture screenshot\nThis screen or window is no longer available. Refresh the list and pick it again.",
		],
		[
			{ success: false, error: "invalid_source" },
			"Failed to capture screenshot\nNo screen or window was picked.",
		],
		[
			{ success: false, error: "capture_failed" },
			"Failed to capture screenshot\nThe capture did not go through. Try again.",
		],
		[{ success: true }, "Failed to capture screenshot"],
	])("says the capture failed and stays open (%j)", async (answer, message) => {
		capture.mockResolvedValue(answer);
		const { onCapture, onOpenChange } = renderPicker();
		fireEvent.click(await screen.findByRole("button", { name: /Entire screen/ }));
		fireEvent.click(captureButton());
		expect((await screen.findByRole("alert")).textContent).toBe(message);
		expect(onCapture).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it.each([
		[new Error("GPU lost"), "Failed to capture screenshot\nGPU lost"],
		["odd", "Failed to capture screenshot"],
	])("says the capture threw (%s)", async (thrown, message) => {
		capture.mockRejectedValue(thrown);
		renderPicker();
		fireEvent.click(await screen.findByRole("button", { name: /Entire screen/ }));
		fireEvent.click(captureButton());
		expect((await screen.findByRole("alert")).textContent).toBe(message);
		expect(captureButton()).toBeEnabled();
	});
});

it("says why in French too", async () => {
	await i18n.changeLanguage("fr");
	capture.mockResolvedValue({ success: false, error: "source_not_found" });
	renderPicker();
	fireEvent.click(await screen.findByRole("button", { name: /Entire screen/ }));
	fireEvent.click(screen.getByRole("button", { name: "Capturer" }));
	expect((await screen.findByRole("alert")).textContent).toMatch(
		/Cet écran ou cette fenêtre n'est plus disponible/,
	);
});

describe("ScreenshotCapture — development build", () => {
	function setPlatform(userAgentData: { platform: string } | undefined, userAgent: string) {
		if (userAgentData) {
			Object.defineProperty(navigator, "userAgentData", {
				value: userAgentData,
				configurable: true,
			});
		}
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
	}

	it.each([
		[{ platform: "macOS" }, "Mozilla/5.0 (X11; Linux x86_64)", "Cmd+V"],
		[{ platform: "Windows" }, "Mozilla/5.0 (Macintosh)", "Ctrl+V"],
		[{ platform: "" }, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "Cmd+V"],
		[undefined, "Mozilla/5.0 (X11; Linux x86_64)", "Ctrl+V"],
	])("says capture is unavailable and how to paste instead (%j, %s)", async (data, agent, keys) => {
		setPlatform(data, agent);
		getSources.mockResolvedValue({ success: false, devMode: true });
		renderPicker();
		expect(await screen.findByText("Screenshot capture unavailable")).toBeInTheDocument();
		expect(
			screen.getByText(
				`Use an external screenshot tool and paste directly into the task description with ${keys}.`,
			),
		).toBeInTheDocument();
		expect(refreshButton()).toBeDisabled();
		expect(captureButton()).toBeDisabled();
		expect(screen.queryByText("No screens or windows found")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
