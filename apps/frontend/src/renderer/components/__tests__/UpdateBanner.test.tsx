/**
 * @vitest-environment jsdom
 */
/**
 * The sidebar banner that offers an app update: when it shows, downloading
 * with its progress, installing, errors, the read-only volume warning,
 * dismissing, and the periodic check.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { UpdateBanner } from "../UpdateBanner";

type Listener = (payload?: unknown) => void;
const listeners: Record<string, Listener> = {};
const cleanups: Record<string, ReturnType<typeof vi.fn>> = {};

function listen(name: string) {
	return vi.fn((callback: Listener) => {
		listeners[name] = callback;
		cleanups[name] = vi.fn();
		return cleanups[name];
	});
}

const api = {
	checkAppUpdate: vi.fn(),
	getDownloadedAppUpdate: vi.fn(),
	downloadAppUpdate: vi.fn(),
	installAppUpdate: vi.fn(),
	onAppUpdateAvailable: listen("available"),
	onAppUpdateProgress: listen("progress"),
	onAppUpdateDownloaded: listen("downloaded"),
	onAppUpdateError: listen("error"),
	onAppUpdateReadOnlyVolume: listen("readOnly"),
};

const NONE = { success: true, data: null };
const found = (version: string) => ({ success: true, data: { version, releaseNotes: "notes" } });

function emit(name: string, payload?: unknown) {
	act(() => listeners[name](payload));
}

beforeEach(async () => {
	vi.clearAllMocks();
	await i18n.changeLanguage("en");
	api.checkAppUpdate.mockResolvedValue(found("2.0.0"));
	api.getDownloadedAppUpdate.mockResolvedValue(NONE);
	api.downloadAppUpdate.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, api);
});

afterEach(() => {
	vi.useRealTimers();
});

const updateButton = () => screen.getByRole("button", { name: /Restart|Downloading/ });

describe("UpdateBanner", () => {
	it("shows nothing while there is no update, even when a check fails", async () => {
		api.checkAppUpdate.mockResolvedValueOnce(NONE);
		const { container, unmount } = render(<UpdateBanner />);
		await waitFor(() => expect(api.getDownloadedAppUpdate).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
		unmount();
		api.checkAppUpdate.mockRejectedValueOnce(new Error("offline"));
		api.getDownloadedAppUpdate.mockRejectedValueOnce(new Error("offline"));
		const second = render(<UpdateBanner />);
		await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledTimes(2));
		expect(second.container).toBeEmptyDOMElement();
	});

	it("offers a found update, downloads it with its progress, then installs it", async () => {
		const user = userEvent.setup();
		render(<UpdateBanner className="extra" />);
		expect(await screen.findByText("Version 2.0.0 is ready")).toBeInTheDocument();
		expect(screen.getByText("Update Available")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Update and Restart" }));
		expect(api.downloadAppUpdate).toHaveBeenCalledTimes(1);
		expect(updateButton()).toBeDisabled();
		expect(updateButton()).toHaveTextContent("Downloading...");
		expect(screen.queryByRole("progressbar")).toBeNull();

		emit("progress", { percent: 42.4, transferred: 1, total: 2 });
		expect(screen.getByText("42%")).toBeInTheDocument();
		expect(screen.getByRole("progressbar", { name: "Downloading..." })).toHaveAttribute("aria-valuenow", "42");
		emit("progress", { percent: 104, transferred: 2, total: 2 });
		expect(screen.getByText("100%")).toBeInTheDocument();
		expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");

		emit("downloaded", { version: "2.0.0" });
		expect(screen.queryByRole("progressbar")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Install and Restart" }));
		expect(api.installAppUpdate).toHaveBeenCalledTimes(1);
		expect(api.downloadAppUpdate).toHaveBeenCalledTimes(1);
	});

	it("offers to install an update downloaded before it was mounted", async () => {
		api.checkAppUpdate.mockResolvedValue(NONE);
		api.getDownloadedAppUpdate.mockResolvedValueOnce(found("1.9.0"));
		render(<UpdateBanner />);
		expect(await screen.findByText("Version 1.9.0 is ready")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Install and Restart" })).toBeEnabled();
	});

	it.each([
		["the updater's reason", { success: false, error: "No space left" }, "No space left"],
		["a generic reason", { success: false }, "Failed to download update"],
	])("shows %s when the download is refused, and can retry", async (_name, result, text) => {
		const user = userEvent.setup();
		api.downloadAppUpdate.mockResolvedValueOnce(result);
		render(<UpdateBanner />);
		await user.click(await screen.findByRole("button", { name: "Update and Restart" }));
		expect(await screen.findByText(text)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Update and Restart" }));
		expect(screen.queryByText(text)).toBeNull();
	});

	it("says when the download could not start", async () => {
		const user = userEvent.setup();
		api.downloadAppUpdate.mockRejectedValueOnce(new Error("ipc"));
		render(<UpdateBanner />);
		await user.click(await screen.findByRole("button", { name: "Update and Restart" }));
		expect(await screen.findByText("Failed to download update")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Update and Restart" })).toBeEnabled();
	});

	it("shows an error the updater reports while downloading", async () => {
		const user = userEvent.setup();
		render(<UpdateBanner />);
		await user.click(await screen.findByRole("button", { name: "Update and Restart" }));
		emit("progress", { percent: 10, transferred: 1, total: 10 });
		emit("error", { message: "Checksum mismatch" });
		expect(screen.getByText("Checksum mismatch")).toBeInTheDocument();
		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.getByRole("button", { name: "Update and Restart" })).toBeEnabled();
	});

	it("warns to move the app before installing from a read-only volume", async () => {
		render(<UpdateBanner />);
		await screen.findByText("Version 2.0.0 is ready");
		emit("readOnly");
		expect(screen.getByText("Move to Applications folder to update")).toBeInTheDocument();
		expect(updateButton()).toBeDisabled();
	});

	it("stays dismissed for the same version and comes back for a newer one", async () => {
		const user = userEvent.setup();
		render(<UpdateBanner />);
		await user.click(await screen.findByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("Update Available")).toBeNull();
		emit("available", { version: "2.0.0" });
		expect(screen.queryByText("Update Available")).toBeNull();
		emit("available", { version: "2.1.0" });
		expect(screen.getByText("Version 2.1.0 is ready")).toBeInTheDocument();
	});

	it("keeps a downloaded update when the same version is announced again", async () => {
		render(<UpdateBanner />);
		await screen.findByText("Version 2.0.0 is ready");
		emit("downloaded", { version: "2.0.0" });
		emit("available", { version: "2.0.0", releaseNotes: "again" });
		expect(screen.getByRole("button", { name: "Install and Restart" })).toBeEnabled();
		// A newer version is a new download.
		emit("available", { version: "2.1.0" });
		expect(screen.getByRole("button", { name: "Update and Restart" })).toBeEnabled();
	});

	it("checks again every five minutes and resets what was about an older version", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		render(<UpdateBanner />);
		await screen.findByText("Version 2.0.0 is ready");
		emit("readOnly");
		emit("downloaded", { version: "2.0.0" });
		emit("readOnly");

		// The same version: nothing changes.
		await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
		expect(api.checkAppUpdate).toHaveBeenCalledTimes(2);
		expect(screen.getByText("Move to Applications folder to update")).toBeInTheDocument();

		api.checkAppUpdate.mockResolvedValueOnce(found("2.2.0"));
		await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
		expect(await screen.findByText("Version 2.2.0 is ready")).toBeInTheDocument();
		expect(screen.queryByText("Move to Applications folder to update")).toBeNull();
		expect(screen.getByRole("button", { name: "Update and Restart" })).toBeEnabled();
	});

	it("stops checking and listening once unmounted", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const { unmount } = render(<UpdateBanner />);
		await act(async () => undefined);
		unmount();
		for (const name of ["available", "progress", "downloaded", "error", "readOnly"]) {
			expect(cleanups[name]).toHaveBeenCalledTimes(1);
		}
		await act(async () => vi.advanceTimersByTime(10 * 60 * 1000));
		expect(api.checkAppUpdate).toHaveBeenCalledTimes(1);
	});
});
