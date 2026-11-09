/**
 * The renderer never hands the main process a command line to run in a
 * terminal: the main process builds every such command itself (install,
 * update, auth). These tests pin the removal of `shell:openTerminalWithCommand`,
 * which forwarded a renderer string to `openTerminalWithCommand` as is.
 */

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createElectronAPI } from "..";
import { createShellAPI } from "../modules/shell-api";

describe("no command line from the renderer", () => {
	it("has no channel that opens a terminal with a renderer command", () => {
		expect(Object.values(IPC_CHANNELS)).not.toContain(
			"shell:openTerminalWithCommand",
		);
	});

	it("exposes only the shell methods that take a URL, a directory or a path to name", () => {
		// toHostPath only rewrites a path string for the clipboard (Windows form
		// under WSL): it runs nothing.
		expect(Object.keys(createShellAPI()).sort()).toEqual([
			"openExternal",
			"openTerminal",
			"toHostPath",
		]);
		expect(
			(createElectronAPI() as unknown as Record<string, unknown>)
				.openTerminalWithCommand,
		).toBeUndefined();
	});
});
