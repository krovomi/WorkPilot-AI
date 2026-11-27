/**
 * Code mode (Settings, Code mode): whether agents may chain their tools in a
 * script (`run_script` in the WorkPilot loop). `off` is the product as it was
 * before code mode, and the default; `auto` offers it to the phases where it
 * pays (coding, QA, the analyses of the code); `on` to every agent that has
 * tools. Read again by `apps/backend/code_mode/settings.py`.
 */

export const CODE_MODES = ["off", "auto", "on"] as const;
export type CodeModeSetting = (typeof CODE_MODES)[number];
export const DEFAULT_CODE_MODE: CodeModeSetting = "off";

/** A saved value as the backend will read it: anything unknown is `off`. */
export function normalizeCodeMode(value: unknown): CodeModeSetting {
	return typeof value === "string" && (CODE_MODES as readonly string[]).includes(value)
		? (value as CodeModeSetting)
		: DEFAULT_CODE_MODE;
}
