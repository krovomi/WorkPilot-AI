/**
 * The agent safety settings (Settings, Sandbox and Anomaly detection), as
 * the one variable every agent process reads: `WORKPILOT_AGENT_SAFETY`.
 *
 * Read from the settings file at each spawn, so a change applies to the next
 * session started, and normalized on the way out; the backend bounds it again
 * (`apps/backend/security/agent_safety_settings.py`). Absent settings send
 * the defaults, so what the backend applies is always what the pages showed.
 */

import { normalizeAgentSafety } from "../../shared/utils/agent-safety";
import { readSettingsFile } from "../settings-utils";

export const AGENT_SAFETY_ENV = "WORKPILOT_AGENT_SAFETY";

export function agentSafetyEnv(
	settings: Record<string, unknown> | undefined = readSettingsFile(),
): Record<string, string> {
	return {
		[AGENT_SAFETY_ENV]: JSON.stringify(normalizeAgentSafety(settings?.agentSafety)),
	};
}
