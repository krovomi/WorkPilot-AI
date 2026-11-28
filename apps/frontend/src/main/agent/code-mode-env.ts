/**
 * The code mode switch (Settings, Code mode) as the variable every agent
 * process reads: `WORKPILOT_CODE_MODE` (`apps/backend/code_mode/settings.py`).
 *
 * Read from the settings file at each spawn, so a change applies to the next
 * session started. An absent or unknown value sends `off`.
 */

import { normalizeCodeMode } from "../../shared/utils/code-mode";
import { readSettingsFile } from "../settings-utils";

export const CODE_MODE_ENV = "WORKPILOT_CODE_MODE";

export function codeModeEnv(
	settings: Record<string, unknown> | undefined = readSettingsFile(),
): Record<string, string> {
	return { [CODE_MODE_ENV]: normalizeCodeMode(settings?.codeMode) };
}

/** Claude Code's own code mode switch (its `REPL` tool). */
export const CLAUDE_CODE_MODE_ENV = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";

/**
 * What a terminal gets: Claude Code's code mode on when the switch is on or
 * auto. An interactive Claude Code reads the variable from its environment;
 * with the switch off nothing is added, so a value the person set stays.
 */
export function terminalCodeModeEnv(
	settings: Record<string, unknown> | undefined = readSettingsFile(),
): Record<string, string> {
	return normalizeCodeMode(settings?.codeMode) === "off"
		? {}
		: { [CLAUDE_CODE_MODE_ENV]: "1" };
}
