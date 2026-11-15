/**
 * GitHubCopilotAuthTerminal — the terminal `gh auth login` runs in: it types
 * the command, reads the account GitHub signed in, lets the person try again
 * after a failure, and never leaves a terminal running once it is closed.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { resetStubs, stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import { GitHubCopilotAuthTerminal } from "../GitHubCopilotAuthTerminal";

const { terminals, auth } = vi.hoisted(() => ({
	terminals: [] as Array<{ writeln: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; input: (data: string) => void; dispose: ReturnType<typeof vi.fn> }>,
	auth: { url: null as string | null, scan: vi.fn() },
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		writeln = vi.fn();
		write = vi.fn();
		open = vi.fn();
		loadAddon = vi.fn();
		dispose = vi.fn();
		input: (data: string) => void = () => undefined;
		constructor() {
			terminals.push(this);
		}
		onData(listener: (data: string) => void) {
			this.input = listener;
			return { dispose: vi.fn() };
		}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit = vi.fn();
	},
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../terminal/terminal-interactions", () => ({ attachTerminalInteractions: vi.fn() }));
vi.mock("../../terminal/use-terminal-auth-url", () => ({
	useTerminalAuthUrl: () => ({ authUrl: auth.url, scanForAuthUrl: auth.scan }),
}));
vi.mock("../../terminal/TerminalAuthLinkBar", () => stubModule("TerminalAuthLinkBar"));

type Listener = (...args: never[]) => void;
let api: RendererApi;
const listeners: Record<string, Listener> = {};
let create: ReturnType<typeof vi.fn>;

function listen(name: string) {
	return vi.fn((listener: Listener) => {
		listeners[name] = listener;
		return () => delete listeners[name];
	});
}

function emit(name: string, ...args: unknown[]) {
	act(() => (listeners[name] as (...a: unknown[]) => void)?.(...args));
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	create = vi.fn(async () => ({ success: true }));
	api = installRendererApi({
		createTerminal: create,
		destroyTerminal: vi.fn(async () => undefined),
		onTerminalOutput: listen("output"),
		onTerminalOAuthToken: listen("token"),
		onTerminalExit: listen("exit"),
		onTerminalOnboardingComplete: listen("onboarding"),
	});
});

afterEach(async () => {
	cleanup();
	api.restore();
	resetStubs();
	terminals.length = 0;
	auth.url = null;
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

function renderTerminal(props: Partial<Parameters<typeof GitHubCopilotAuthTerminal>[0]> = {}) {
	const onClose = vi.fn();
	const onAuthSuccess = vi.fn();
	const onAuthError = vi.fn();
	const view = render(
		<GitHubCopilotAuthTerminal
			terminalId="copilot-auth-1"
			profileName="Work"
			onClose={onClose}
			onAuthSuccess={onAuthSuccess}
			onAuthError={onAuthError}
			{...props}
		/>,
	);
	return { onClose, onAuthSuccess, onAuthError, ...view };
}

const sent = () => globalThis.electronAPI.sendTerminalInput as unknown as ReturnType<typeof vi.fn>;
const destroyed = () => globalThis.electronAPI.destroyTerminal as unknown as ReturnType<typeof vi.fn>;
const header = () => screen.getByRole("button", { name: "Close" }).parentElement as HTMLElement;
const ready = () => act(async () => undefined);

describe("GitHubCopilotAuthTerminal", () => {
	it("types gh auth login for the person to run, and follows the sign-in to its account", async () => {
		const { onAuthSuccess, onClose } = renderTerminal();
		expect(header()).toHaveTextContent("Connecting…");
		await ready();
		expect(create).toHaveBeenCalledWith({ id: "copilot-auth-1", cols: 80, rows: 24, skipOAuthToken: true, env: {} });
		expect(header()).toHaveTextContent("Authenticate: Work");
		expect(terminals[0].writeln.mock.calls.map(([line]) => line).join("\n")).toContain("Press Enter to run gh auth login");
		act(() => vi.advanceTimersByTime(600));
		expect(sent()).toHaveBeenCalledWith("copilot-auth-1", "gh auth login");
		terminals[0].input("\r");
		terminals[0].input("ab");
		expect(sent()).toHaveBeenLastCalledWith("copilot-auth-1", "ab");

		emit("output", "other", "gh auth login");
		expect(header()).toHaveTextContent("Authenticate: Work");
		emit("output", "copilot-auth-1", "? What is your preferred protocol for Git operations?");
		expect(screen.getByText("Finish the sign-in in your browser…")).toBeInTheDocument();
		emit("output", "copilot-auth-1", "✓ Logged in to github.com account octocat (keyring)");
		expect(onAuthSuccess).toHaveBeenCalledWith("octocat");
		expect(header()).toHaveTextContent("Authenticated as octocat");
		act(() => vi.advanceTimersByTime(1600));
		expect(destroyed()).toHaveBeenCalledWith("copilot-auth-1");
		expect(onClose).toHaveBeenCalledTimes(1);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(globalThis.electronAPI.resizeTerminal).toHaveBeenCalledWith("copilot-auth-1", 80, 24);
	});

	it("reads the older « Logged in as » line, and a clean exit after the browser step", async () => {
		const first = renderTerminal();
		await ready();
		emit("output", "copilot-auth-1", "✓ Logged in as hubot");
		expect(first.onAuthSuccess).toHaveBeenCalledWith("hubot");
		// Reported once.
		emit("output", "copilot-auth-1", "Authentication complete.");
		expect(first.onAuthSuccess).toHaveBeenCalledTimes(1);
		cleanup();

		const second = renderTerminal();
		await ready();
		emit("exit", "copilot-auth-1", 0);
		expect(second.onAuthSuccess).not.toHaveBeenCalled();
		emit("output", "copilot-auth-1", "gh auth login");
		emit("exit", "other", 0);
		emit("exit", "copilot-auth-1", 1);
		expect(second.onAuthSuccess).not.toHaveBeenCalled();
		emit("exit", "copilot-auth-1", 0);
		expect(second.onAuthSuccess).toHaveBeenCalledWith(undefined);
		expect(header()).toHaveTextContent("Authenticated!");
		act(() => vi.advanceTimersByTime(1600));
		expect(second.onClose).toHaveBeenCalled();
	});

	it("says why the sign-in failed, and lets the person sign in again in the same terminal", async () => {
		await i18n.changeLanguage("fr");
		const { onAuthError, onAuthSuccess } = renderTerminal();
		await ready();
		emit("output", "copilot-auth-1", "Error: device code expired");
		expect(onAuthError).toHaveBeenCalledWith("device code expired");
		expect(screen.getByText("device code expired")).toBeInTheDocument();
		emit("output", "copilot-auth-1", "Failed to authenticate");
		expect(onAuthError).toHaveBeenLastCalledWith(i18n.t("common:githubCopilot.authTerminal.authFailed"));
		emit("output", "copilot-auth-1", "Error:");
		expect(onAuthError).toHaveBeenLastCalledWith(i18n.t("common:githubCopilot.authTerminal.authFailed"));

		emit("output", "copilot-auth-1", "$ gh auth login");
		expect(screen.getByText(i18n.t("common:githubCopilot.authTerminal.authenticatingMessage"))).toBeInTheDocument();
		emit("output", "copilot-auth-1", "✓ Logged in as octocat");
		expect(onAuthSuccess).toHaveBeenCalledWith("octocat");
	});

	it("says when the terminal cannot be created", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		create.mockResolvedValueOnce({ success: false, error: "No shell" });
		const first = renderTerminal();
		await ready();
		expect(first.onAuthError).toHaveBeenCalledWith("No shell");
		expect(header()).toHaveTextContent("Authentication error");
		cleanup();

		create.mockResolvedValueOnce({ success: false });
		const second = renderTerminal();
		await ready();
		expect(second.onAuthError).toHaveBeenCalledWith("Failed to create the terminal");
		cleanup();

		create.mockRejectedValueOnce(new Error("IPC"));
		const third = renderTerminal();
		await ready();
		expect(third.onAuthError).toHaveBeenCalledWith("IPC");
		cleanup();

		create.mockRejectedValueOnce("odd");
		const fourth = renderTerminal();
		await ready();
		expect(fourth.onAuthError).toHaveBeenCalledWith("Unknown error");
		cleanup();
		expect(destroyed()).not.toHaveBeenCalled();
	});

	it("closes its terminal, also one created after the window was closed", async () => {
		const { onClose } = renderTerminal();
		await ready();
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(destroyed()).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalled();
		cleanup();
		expect(destroyed()).toHaveBeenCalledTimes(1);

		// Unmounted with the terminal still open: it is destroyed.
		renderTerminal({ terminalId: "copilot-auth-2" });
		await ready();
		cleanup();
		expect(destroyed()).toHaveBeenLastCalledWith("copilot-auth-2");

		let finish: (value: unknown) => void = () => undefined;
		create.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const { unmount } = renderTerminal({ terminalId: "copilot-auth-3" });
		unmount();
		await act(async () => finish({ success: true }));
		expect(destroyed()).toHaveBeenLastCalledWith("copilot-auth-3");
		act(() => vi.advanceTimersByTime(600));
		expect(sent()).not.toHaveBeenCalled();
	});

	it("shows the device link until the sign-in succeeds", async () => {
		auth.url = "https://github.com/login/device";
		renderTerminal();
		await ready();
		expect(stubProps("TerminalAuthLinkBar").url).toBe("https://github.com/login/device");
		emit("output", "copilot-auth-1", "Authentication successful");
		expect(screen.queryByTestId("stub-TerminalAuthLinkBar")).toBeNull();
	});
});
