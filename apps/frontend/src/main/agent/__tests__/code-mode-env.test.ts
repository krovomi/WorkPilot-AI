/** Every agent process gets the code mode switch, `off` unless Settings says otherwise. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => ({ codeMode: "auto" }),
}));

import { CODE_MODE_ENV, codeModeEnv } from "../code-mode-env";

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
