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
