/** Every agent process gets the code mode switch, `off` unless Settings says otherwise. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => ({ codeMode: "auto" }),
}));

import {
	CLAUDE_CODE_MODE_ENV,
	CODE_MODE_ENV,
	codeModeEnv,
	terminalCodeModeEnv,
} from "../code-mode-env";

describe("codeModeEnv", () => {
	it("reads the settings file by default", () => {
		expect(codeModeEnv()).toEqual({ [CODE_MODE_ENV]: "auto" });
	});

	it("sends off when nothing, or something unknown, is saved", () => {
		expect(codeModeEnv({})[CODE_MODE_ENV]).toBe("off");
		expect(codeModeEnv(undefined)[CODE_MODE_ENV]).toBe("auto");
		expect(codeModeEnv({ codeMode: "always" })[CODE_MODE_ENV]).toBe("off");
		expect(codeModeEnv({ codeMode: 1 })[CODE_MODE_ENV]).toBe("off");
		expect(codeModeEnv({ codeMode: "on" })[CODE_MODE_ENV]).toBe("on");
	});
});

describe("terminalCodeModeEnv", () => {
	it("turns Claude Code's code mode on in a terminal when the switch is on or auto", () => {
		expect(terminalCodeModeEnv()).toEqual({ [CLAUDE_CODE_MODE_ENV]: "1" });
		expect(terminalCodeModeEnv({ codeMode: "on" })).toEqual({
			[CLAUDE_CODE_MODE_ENV]: "1",
		});
	});

	it("adds nothing when the switch is off, absent or unknown", () => {
		expect(terminalCodeModeEnv({ codeMode: "off" })).toEqual({});
		expect(terminalCodeModeEnv({})).toEqual({});
		expect(terminalCodeModeEnv({ codeMode: "always" })).toEqual({});
	});
});
