/** A terminal's shell gets Claude Code's code mode when the Settings switch asks for it. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, settings } = vi.hoisted(() => ({
	spawn: vi.fn((..._args: unknown[]) => ({ pid: 1 })),
	settings: { saved: {} as Record<string, unknown> },
}));

vi.mock("@lydell/node-pty", () => ({ spawn }));
vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => settings.saved,
}));
vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: vi.fn(),
}));
vi.mock("../../ipc-handlers/utils", () => ({ safeSendToRenderer: vi.fn() }));
vi.mock("../../platform", () => ({
	isWindows: () => false,
	getWindowsShellPaths: () => ({}),
}));

import { spawnPtyProcess } from "../pty-manager";

function spawnedEnv(): Record<string, string> {
	const options = spawn.mock.calls.at(-1)?.[2] as {
		env: Record<string, string>;
	};
	return options.env;
}

describe("spawnPtyProcess and code mode", () => {
	beforeEach(() => {
		spawn.mockClear();
		vi.stubEnv("CLAUDE_CODE_EXPERIMENTAL_CODE_MODE", "");
	});

	it("turns it on when the switch is on or auto", () => {
		for (const codeMode of ["on", "auto"]) {
			settings.saved = { codeMode };
			spawnPtyProcess("/tmp", 80, 24);
			expect(spawnedEnv().CLAUDE_CODE_EXPERIMENTAL_CODE_MODE).toBe("1");
		}
	});

	it("leaves the shell as it was when the switch is off", () => {
		settings.saved = { codeMode: "off" };
		spawnPtyProcess("/tmp", 80, 24);
		expect(spawnedEnv().CLAUDE_CODE_EXPERIMENTAL_CODE_MODE).toBe("");
		expect(spawnedEnv().TERM).toBe("xterm-256color");
	});
});
