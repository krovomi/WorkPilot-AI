/**
 * @vitest-environment jsdom
 *
 * Naming a terminal after what is run in it: a pause after the last command,
 * generic commands skipped, a Claude terminal named once from its first
 * prompt, each switch in the settings honoured, and a failure left silent.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "../../../stores/terminal-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { useTerminalStore } from "../../../stores/terminal-store";
import { useAutoNaming } from "../useAutoNaming";

const initialSettings = useSettingsStore.getState();
const initialTerminals = useTerminalStore.getState();

const api = {
	generateTerminalName: vi.fn(),
	setTerminalTitle: vi.fn(),
};

function withTerminal(overrides: Partial<Terminal> = {}) {
	useTerminalStore.setState({
		terminals: [{ id: "term-1", title: "Terminal 1", cwd: "/work/shop", ...overrides } as Terminal],
	});
}

function setSettings(settings: { autoNameTerminals?: boolean; autoNameClaudeTerminals?: boolean }) {
	useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, ...settings } });
}

const title = () => useTerminalStore.getState().terminals[0].title;

/** Types a command, lets the pause run out, and waits for the name. */
async function run(command: string, cwd?: string) {
	const { result } = renderHook(() => useAutoNaming({ terminalId: "term-1", cwd }));
	act(() => result.current.handleCommandEnter(command));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1500);
	});
	return result;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	api.generateTerminalName.mockResolvedValue({ success: true, data: "Build API" });
	Object.assign(globalThis.electronAPI, api);
	setSettings({ autoNameTerminals: true, autoNameClaudeTerminals: true });
	withTerminal();
});

afterEach(() => {
	useSettingsStore.setState(initialSettings, true);
	useTerminalStore.setState(initialTerminals, true);
	vi.useRealTimers();
});

describe("useAutoNaming", () => {
	it("names the terminal after a meaningful command, in its own folder", async () => {
		await run("  pytest tests/api -k orders  ");
		expect(api.generateTerminalName).toHaveBeenCalledWith("pytest tests/api -k orders", "/work/shop");
		expect(title()).toBe("Build API");
		expect(api.setTerminalTitle).toHaveBeenCalledWith("term-1", "Build API");
		expect(useTerminalStore.getState().terminals[0].claudeNamedOnce).toBeFalsy();
	});

	it("falls back to the folder it was given when the terminal has none", async () => {
		withTerminal({ cwd: "" });
		await run("dotnet test", "/fallback");
		expect(api.generateTerminalName).toHaveBeenCalledWith("dotnet test", "/fallback");
	});

	it("waits for the last of several commands typed in a row", async () => {
		const { result } = renderHook(() => useAutoNaming({ terminalId: "term-1" }));
		act(() => result.current.handleCommandEnter("cargo build"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		act(() => result.current.handleCommandEnter("dotnet watch run"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1499);
		});
		expect(api.generateTerminalName).not.toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(api.generateTerminalName).toHaveBeenCalledTimes(1);
		expect(api.generateTerminalName).toHaveBeenCalledWith("dotnet watch run", "/work/shop");
	});

	it("skips blank, short and generic commands", async () => {
		for (const command of ["   ", "ab", "git status", "LS -la", "npm install", "claude"]) {
			await run(command);
		}
		expect(api.generateTerminalName).not.toHaveBeenCalled();
		expect(title()).toBe("Terminal 1");
	});

	it("leaves the name alone when auto-naming is off", async () => {
		setSettings({ autoNameTerminals: false });
		await run("pytest tests/api");
		expect(api.generateTerminalName).not.toHaveBeenCalled();
	});

	it("names a Claude terminal once, from its first prompt, even a generic word", async () => {
		withTerminal({ isClaudeMode: true });
		await run("git: explain the last merge");
		expect(api.generateTerminalName).toHaveBeenCalledWith("git: explain the last merge", "/work/shop");
		expect(useTerminalStore.getState().terminals[0].claudeNamedOnce).toBe(true);

		await run("now fix the tests");
		expect(api.generateTerminalName).toHaveBeenCalledTimes(1);
	});

	it("leaves a Claude terminal alone when its own switch is off", async () => {
		withTerminal({ isClaudeMode: true });
		setSettings({ autoNameClaudeTerminals: false, autoNameTerminals: true });
		await run("explain the last merge");
		expect(api.generateTerminalName).not.toHaveBeenCalled();
	});

	it("keeps the name when none was generated or the call failed", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		api.generateTerminalName
			.mockResolvedValueOnce({ success: false, error: "no provider" })
			.mockResolvedValueOnce({ success: true, data: "" })
			.mockRejectedValueOnce(new Error("timeout"));
		await run("pytest tests/api");
		await run("pytest tests/api");
		await run("pytest tests/api");
		expect(title()).toBe("Terminal 1");
		expect(api.setTerminalTitle).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith("[Terminal] Auto-naming failed:", expect.any(Error));
		warn.mockRestore();
	});

	it("drops a pending name on cleanup, and cleans up twice without harm", async () => {
		const { result } = renderHook(() => useAutoNaming({ terminalId: "term-1" }));
		act(() => result.current.handleCommandEnter("pytest tests/api"));
		act(() => {
			result.current.cleanup();
			result.current.cleanup();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(api.generateTerminalName).not.toHaveBeenCalled();
	});
});
