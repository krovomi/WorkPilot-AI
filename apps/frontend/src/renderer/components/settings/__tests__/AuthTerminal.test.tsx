/**
 * AuthTerminal — the embedded terminal a provider login runs in: it types the
 * login command, notices the token, the onboarding and the CLI's own success
 * message, and never leaves a terminal running once it is closed, even when
 * it was closed while the terminal was still being created.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { resetStubs, stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import { AuthTerminal } from "../AuthTerminal";

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

function renderTerminal(props: Partial<Parameters<typeof AuthTerminal>[0]> = {}) {
	const onClose = vi.fn();
	const onAuthSuccess = vi.fn();
	const onAuthError = vi.fn();
	const view = render(
		<AuthTerminal
			terminalId="claude-login-p1-1"
			configDir="/profiles/p1"
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

describe("AuthTerminal", () => {
	it("opens a terminal for the profile and types the Claude login, once, for the person to run", async () => {
		renderTerminal();
		expect(header()).toHaveTextContent("Connecting...");
		await ready();
		expect(create).toHaveBeenCalledWith({
			id: "claude-login-p1-1",
			cols: 80,
			rows: 24,
			skipOAuthToken: true,
			env: { CLAUDE_CONFIG_DIR: "/profiles/p1" },
		});
		expect(header()).toHaveTextContent("Authenticate: Work");
		const box = terminals[0].writeln.mock.calls.map(([line]) => line).join("\n");
		expect(box).toContain("Claude Authentication");
		expect(box).toContain("Press Enter to start authentication");

		act(() => vi.advanceTimersByTime(600));
		expect(sent()).toHaveBeenCalledTimes(1);
		expect(sent()).toHaveBeenCalledWith("claude-login-p1-1", "claude /login");
		// What the person types goes to the terminal.
		terminals[0].input("\r");
		terminals[0].input("pasted text");
		expect(sent()).toHaveBeenLastCalledWith("claude-login-p1-1", "pasted text");
		// Output of another terminal is not this one's.
		emit("output", "other", "hello");
		emit("output", "claude-login-p1-1", "visit https://x");
		expect(terminals[0].write).toHaveBeenCalledTimes(1);
		expect(auth.scan).toHaveBeenCalledTimes(1);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(globalThis.electronAPI.resizeTerminal).toHaveBeenCalledWith("claude-login-p1-1", 80, 24);
	});

	it("types a coding-agent CLI's own login without the Claude profile, under its own instructions", async () => {
		renderTerminal({
			terminalId: "auth-opencode-1",
			loginCommand: "opencode auth login",
			instructions: { title: "OpenCode", steps: ["Pick a provider"] },
		});
		await ready();
		expect(create.mock.calls[0][0].env).toBeUndefined();
		const box = terminals[0].writeln.mock.calls.map(([line]) => line).join("\n");
		expect(box).toContain("OpenCode");
		expect(box).toContain("1.\x1b[0m Pick a provider");
		act(() => vi.advanceTimersByTime(600));
		expect(sent()).toHaveBeenCalledWith("auth-opencode-1", "opencode auth login");
	});

	it("gives a CLI account's sign-in its own folder variable only", async () => {
		renderTerminal({
			terminalId: "ai-account-login-codex-1",
			loginCommand: "codex login",
			env: { CODEX_HOME: "/accounts/codex/a" },
		});
		await ready();
		expect(create.mock.calls[0][0].env).toEqual({ CODEX_HOME: "/accounts/codex/a" });
	});

	it("runs the Codex login at once and reports its success without inventing an address", async () => {
		const { onAuthSuccess, onClose } = renderTerminal({ terminalId: "auth-codex-1" });
		await ready();
		act(() => vi.advanceTimersByTime(600));
		expect(sent()).toHaveBeenCalledWith("auth-codex-1", "codex login\r");
		emit("output", "auth-codex-1", "Waiting for the browser…");
		expect(onAuthSuccess).not.toHaveBeenCalled();
		emit("output", "auth-codex-1", "Login successful");
		expect(onAuthSuccess).toHaveBeenCalledWith(undefined);
		expect(header()).toHaveTextContent("Authenticated!");
		expect(screen.getByText("Authentication successful! Closing...")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(2100));
		expect(destroyed()).toHaveBeenCalledWith("auth-codex-1");
		expect(onClose).toHaveBeenCalled();
	});

	it("reads the Codex account when the CLI prints it, and counts a clean exit as signed in", async () => {
		const first = renderTerminal({ terminalId: "auth-codex-2" });
		await ready();
		emit("output", "auth-codex-2", "Login successful. Account: dev@example.com");
		expect(first.onAuthSuccess).toHaveBeenCalledWith("dev@example.com");
		expect(header()).toHaveTextContent("Authenticated as dev@example.com");
		cleanup();

		const second = renderTerminal({ terminalId: "auth-codex-3" });
		await ready();
		emit("exit", "auth-codex-3", 1);
		expect(second.onAuthSuccess).not.toHaveBeenCalled();
		emit("exit", "auth-codex-3", 0);
		expect(second.onAuthSuccess).toHaveBeenCalledWith(undefined);
		expect(header()).toHaveTextContent("Authenticated!");
	});

	it("reports the token at once, then waits for the onboarding before closing", async () => {
		const { onAuthSuccess, onClose } = renderTerminal();
		await ready();
		emit("token", { terminalId: "other", success: true });
		emit("onboarding", { terminalId: "claude-login-p1-1" });
		expect(onAuthSuccess).not.toHaveBeenCalled();
		emit("token", { terminalId: "claude-login-p1-1", success: true, needsOnboarding: true, email: "me@example.com" });
		expect(onAuthSuccess).toHaveBeenCalledWith("me@example.com");
		expect(header()).toHaveTextContent("Complete setup: Work");
		expect(screen.getByText(/Token received!/)).toBeInTheDocument();
		emit("onboarding", { terminalId: "claude-login-p1-1" });
		expect(header()).toHaveTextContent("Authenticated as me@example.com");
		act(() => vi.advanceTimersByTime(1600));
		expect(destroyed()).toHaveBeenCalledWith("claude-login-p1-1");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onAuthSuccess).toHaveBeenCalledTimes(1);
	});

	it("finishes an onboarding when the terminal exits cleanly", async () => {
		const { onAuthSuccess } = renderTerminal();
		await ready();
		emit("token", { terminalId: "claude-login-p1-1", success: true, needsOnboarding: true });
		emit("exit", "claude-login-p1-1", 0);
		expect(header()).toHaveTextContent("Authenticated!");
		expect(onAuthSuccess).toHaveBeenCalledTimes(1);
		cleanup();

		renderTerminal();
		await ready();
		emit("token", { terminalId: "claude-login-p1-1", success: true });
		expect(header()).toHaveTextContent("Authenticated!");
		// An exit after the success changes nothing.
		emit("exit", "claude-login-p1-1", 0);
		expect(header()).toHaveTextContent("Authenticated!");
	});

	it("says why the login failed", async () => {
		await i18n.changeLanguage("fr");
		const { onAuthError } = renderTerminal();
		await ready();
		emit("token", { terminalId: "claude-login-p1-1", success: false, message: "Token refusé" });
		expect(onAuthError).toHaveBeenCalledWith("Token refusé");
		expect(screen.getByText("Token refusé")).toBeInTheDocument();
		emit("token", { terminalId: "claude-login-p1-1", success: false });
		expect(onAuthError).toHaveBeenLastCalledWith(i18n.t("common:authTerminal.authFailed"));
	});

	it("says when the terminal cannot be created", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		create.mockResolvedValueOnce({ success: false, error: "No shell" });
		const first = renderTerminal();
		await ready();
		expect(first.onAuthError).toHaveBeenCalledWith("No shell");
		expect(header()).toHaveTextContent("Authentication Error");
		cleanup();

		create.mockResolvedValueOnce({ success: false });
		const second = renderTerminal();
		await ready();
		expect(second.onAuthError).toHaveBeenCalledWith("Failed to create terminal");
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
		// Nothing was created, so nothing is destroyed.
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
		// Destroyed once: the close already did it.
		expect(destroyed()).toHaveBeenCalledTimes(1);

		let finish: (value: unknown) => void = () => undefined;
		create.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const { unmount } = renderTerminal({ terminalId: "claude-login-p2-1" });
		unmount();
		await act(async () => finish({ success: true }));
		expect(destroyed()).toHaveBeenLastCalledWith("claude-login-p2-1");
		act(() => vi.advanceTimersByTime(600));
		expect(sent()).not.toHaveBeenCalled();
	});

	it("shows the sign-in link until the login succeeds", async () => {
		auth.url = "https://claude.ai/oauth?code=1";
		renderTerminal();
		await ready();
		expect(stubProps("TerminalAuthLinkBar").url).toBe("https://claude.ai/oauth?code=1");
		emit("token", { terminalId: "claude-login-p1-1", success: true });
		expect(screen.queryByTestId("stub-TerminalAuthLinkBar")).toBeNull();
	});
});
