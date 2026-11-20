/**
 * Signing in to GitHub through the GitHub CLI: the flow checks that gh is
 * installed and signed in, runs the device flow otherwise (code shown as soon
 * as the main reads it), and tells the caller once the CLI holds a token.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { GitHubOAuthFlow } from "../GitHubOAuthFlow";

type DeviceCode = { deviceCode?: string; authUrl?: string; browserOpened: boolean };

const MASK = "••••••••";
let deviceListener: ((data: DeviceCode) => void) | null = null;
const stopListening = vi.fn();

const api = {
	checkGitHubCli: vi.fn(),
	checkGitHubAuth: vi.fn(),
	getGitHubToken: vi.fn(),
	startGitHubAuth: vi.fn(),
	onGitHubAuthDeviceCode: vi.fn((cb: (data: DeviceCode) => void) => {
		deviceListener = cb;
		return stopListening;
	}),
};

const writeText = vi.fn();
let previousApi: unknown;
let open: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	for (const fn of Object.values(api)) fn.mockClear();
	api.checkGitHubCli.mockReset();
	api.checkGitHubAuth.mockReset();
	api.getGitHubToken.mockReset();
	api.startGitHubAuth.mockReset();
	stopListening.mockReset();
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	deviceListener = null;
	api.checkGitHubCli.mockResolvedValue({
		success: true,
		data: { installed: true, version: "2.60.0" },
	});
	api.checkGitHubAuth.mockResolvedValue({
		success: true,
		data: { authenticated: false },
	});
	api.getGitHubToken.mockResolvedValue({ success: true, data: { token: MASK } });
	previousApi = (globalThis as { electronAPI?: unknown }).electronAPI;
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	open = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = previousApi;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function mount(props: { onCancel?: () => void } = {}) {
	const onSuccess = vi.fn();
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(<GitHubOAuthFlow onSuccess={onSuccess} {...props} />);
	});
	return { onSuccess, ...view };
}

const click = (name: string | RegExp) =>
	act(async () => {
		fireEvent.click(screen.getByRole("button", { name }));
	});

describe("GitHubOAuthFlow", () => {
	it("hands over the CLI's sign-in and its account when gh is already signed in", async () => {
		api.checkGitHubAuth.mockResolvedValue({
			success: true,
			data: { authenticated: true, username: "octo" },
		});
		const { onSuccess } = await mount();
		expect(onSuccess).toHaveBeenCalledWith(MASK, "octo");
		expect(screen.getByText("Connected as octo")).toBeTruthy();
	});

	it("asks to install gh, then checks again", async () => {
		api.checkGitHubCli.mockResolvedValueOnce({
			success: true,
			data: { installed: false },
		});
		await mount();
		expect(screen.getByText("GitHub CLI Required")).toBeTruthy();
		expect(screen.getByText("brew install gh").tagName).toBe("CODE");

		await click("Install GitHub CLI");
		expect(open).toHaveBeenCalledWith("https://cli.github.com/", "_blank");

		await click("I've Installed It");
		expect(screen.getByText("Using GitHub CLI 2.60.0")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Authenticate with GitHub" })).toBeTruthy();
	});

	it("shows the device code as soon as the main reads it, then finishes", async () => {
		let finish: (v: unknown) => void = () => undefined;
		api.startGitHubAuth.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const { onSuccess } = await mount();
		await click("Authenticate with GitHub");
		expect(screen.getByText(/Waiting for authentication flow to start/)).toBeTruthy();

		act(() => deviceListener?.({ browserOpened: false }));
		expect(screen.queryByText("Your one-time code")).toBeNull();

		act(() =>
			deviceListener?.({
				deviceCode: "ABCD-1234",
				authUrl: "https://github.com/login/device",
				browserOpened: false,
			}),
		);
		expect(screen.getByText("ABCD-1234")).toBeTruthy();
		expect(screen.getByText(/Copy this code, then open the link/)).toBeTruthy();

		await click("Open https://github.com/login/device");
		expect(open).toHaveBeenCalledWith("https://github.com/login/device", "_blank");

		await act(async () =>
			finish({
				success: true,
				data: { success: true, deviceCode: "ABCD-1234", browserOpened: true },
			}),
		);
		expect(onSuccess).toHaveBeenCalledWith(MASK, undefined);
		expect(screen.getByText("Your GitHub account is now connected")).toBeTruthy();
		expect(stopListening).toHaveBeenCalled();
	});

	it("copies the code and says so for two seconds", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.startGitHubAuth.mockReturnValue(new Promise(() => undefined));
		await mount();
		await click("Authenticate with GitHub");
		act(() =>
			deviceListener?.({ deviceCode: "WXYZ-9876", browserOpened: true }),
		);
		expect(screen.getByText(/Enter this code in your browser/)).toBeTruthy();

		await click("Copy");
		await click("Copied");
		expect(writeText).toHaveBeenCalledWith("WXYZ-9876");
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();

		writeText.mockRejectedValueOnce(new Error("denied"));
		await click("Copy");
		expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
	});

	it("gives up after five minutes without an answer", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.startGitHubAuth.mockReturnValue(new Promise(() => undefined));
		await mount();
		await click("Authenticate with GitHub");

		await act(async () => {
			vi.advanceTimersByTime(5 * 60 * 1000);
		});
		expect(screen.getByText("Authentication Timed Out")).toBeTruthy();
		expect(
			screen.getByText("The sign-in window stayed open too long. Please try again."),
		).toBeTruthy();
	});

	it("does not time out once gh has answered", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.startGitHubAuth.mockResolvedValue({ success: true, data: { success: true } });
		await mount();
		await click("Authenticate with GitHub");
		await act(async () => {
			vi.advanceTimersByTime(5 * 60 * 1000);
		});
		expect(screen.queryByText("Authentication Timed Out")).toBeNull();
	});

	it("offers the link and the code by hand when the sign-in fails", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.startGitHubAuth.mockResolvedValue({
			success: false,
			error: "browser did not open",
			data: {
				success: false,
				deviceCode: "QQQQ-0000",
				fallbackUrl: "https://github.com/login/device",
			},
		});
		const onCancel = vi.fn();
		await mount({ onCancel });
		await click("Authenticate with GitHub");

		expect(screen.getByText("Authentication Failed")).toBeTruthy();
		expect(screen.getByText("browser did not open")).toBeTruthy();
		expect(screen.getByText("Complete Authentication Manually")).toBeTruthy();
		expect(screen.getByText("QQQQ-0000")).toBeTruthy();

		await click("Copy");
		expect(writeText).toHaveBeenCalledWith("https://github.com/login/device");
		expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
		await click("Copied");
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
		writeText.mockRejectedValueOnce(new Error("denied"));
		await click("Copy");
		expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();

		await click("Open URL in Browser");
		expect(open).toHaveBeenCalledWith("https://github.com/login/device", "_blank");

		await click("Cancel");
		expect(onCancel).toHaveBeenCalled();

		api.startGitHubAuth.mockReturnValue(new Promise(() => undefined));
		await click("Retry");
		expect(api.startGitHubAuth).toHaveBeenCalledTimes(2);
		expect(screen.getByText("Authenticating...")).toBeTruthy();
	});

	it("explains each failure in the app's words when gh gives none", async () => {
		api.checkGitHubCli.mockResolvedValueOnce({ success: false });
		const first = await mount();
		expect(screen.getByText("Could not check the GitHub CLI")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		// Retry after a failed check checks again rather than starting a sign-in.
		await click("Retry");
		expect(api.checkGitHubCli).toHaveBeenCalledTimes(2);
		expect(api.startGitHubAuth).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Authenticate with GitHub" })).toBeTruthy();
		first.unmount();

		api.checkGitHubCli.mockResolvedValueOnce({ success: false, error: "gh broke" });
		const second = await mount();
		expect(screen.getByText("gh broke")).toBeTruthy();
		second.unmount();

		api.checkGitHubCli.mockRejectedValueOnce("odd");
		const third = await mount();
		expect(screen.getByText("Could not check the GitHub CLI")).toBeTruthy();
		third.unmount();

		api.checkGitHubCli.mockRejectedValueOnce(new Error("spawn ENOENT"));
		const fourth = await mount();
		expect(screen.getByText("spawn ENOENT")).toBeTruthy();
		fourth.unmount();
	});

	it("reports a sign-in it cannot read", async () => {
		api.checkGitHubAuth.mockResolvedValue({
			success: true,
			data: { authenticated: true, username: "octo" },
		});
		api.getGitHubToken.mockResolvedValueOnce({ success: false });
		const first = await mount();
		expect(screen.getByText("Could not read the GitHub CLI sign-in")).toBeTruthy();
		first.unmount();

		api.getGitHubToken.mockResolvedValueOnce({ success: false, error: "no token" });
		const second = await mount();
		expect(screen.getByText("no token")).toBeTruthy();
		second.unmount();

		api.getGitHubToken.mockRejectedValueOnce(new Error("ipc down"));
		const third = await mount();
		expect(screen.getByText("ipc down")).toBeTruthy();
		third.unmount();

		api.getGitHubToken.mockRejectedValueOnce(null);
		const { onSuccess } = await mount();
		expect(screen.getByText("Could not read the GitHub CLI sign-in")).toBeTruthy();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("reports a device flow that breaks", async () => {
		api.startGitHubAuth.mockResolvedValueOnce({ success: false, data: { success: false } });
		await mount();
		await click("Authenticate with GitHub");
		expect(screen.getAllByText("Authentication Failed")).toHaveLength(2);
		expect(screen.queryByText("Complete Authentication Manually")).toBeNull();

		// Retry runs the sign-in again, not the CLI check that went fine.
		api.startGitHubAuth.mockRejectedValueOnce(new Error("gh crashed"));
		await click("Retry");
		expect(screen.getByText("gh crashed")).toBeTruthy();

		api.startGitHubAuth.mockRejectedValueOnce(42);
		await click("Retry");
		expect(screen.getAllByText("Authentication Failed")).toHaveLength(2);
		expect(api.startGitHubAuth).toHaveBeenCalledTimes(3);
		expect(api.checkGitHubCli).toHaveBeenCalledTimes(1);
	});

	it("can be cancelled while waiting, and stops its timers when closed", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.startGitHubAuth.mockReturnValue(new Promise(() => undefined));
		const onCancel = vi.fn();
		const { unmount } = await mount({ onCancel });
		await click("Cancel");
		await click("Authenticate with GitHub");
		act(() => deviceListener?.({ deviceCode: "AAAA-1111", browserOpened: true }));
		await click("Copy");
		await click("Cancel");
		expect(onCancel).toHaveBeenCalledTimes(2);

		const clear = vi.spyOn(globalThis, "clearTimeout");
		unmount();
		expect(clear).toHaveBeenCalledTimes(2);
	});

	it("checks gh once under Strict Mode's double effects", async () => {
		await act(async () => {
			render(
				<StrictMode>
					<GitHubOAuthFlow onSuccess={vi.fn()} />
				</StrictMode>,
			);
		});
		expect(api.checkGitHubCli).toHaveBeenCalledTimes(1);
	});

	it("takes the link from gh's answer when no event brought it", async () => {
		api.startGitHubAuth.mockResolvedValue({
			success: false,
			error: "expired",
			data: { success: false, authUrl: "https://github.com/login/device", browserOpened: false },
		});
		await mount();
		await click("Authenticate with GitHub");
		expect(screen.getByText("expired")).toBeTruthy();
		expect(screen.getByText("https://github.com/login/device")).toBeTruthy();
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		api.checkGitHubCli.mockResolvedValueOnce({ success: false });
		await mount();
		expect(screen.getByText("Impossible de vérifier la CLI GitHub")).toBeTruthy();
	});
});
