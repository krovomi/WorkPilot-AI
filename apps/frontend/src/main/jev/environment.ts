import { readSettingsFile } from "../settings-utils";
import { parseJevSettings } from "../../shared/utils/jev-settings";
import { getJevService } from "./service";
export function buildJevEnvironment(
	base: NodeJS.ProcessEnv,
	workflow?: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (
			value !== undefined &&
			key !== "TYPESAFE_API_KEY" &&
			!key.startsWith("WORKPILOT_JEV_")
		)
			env[key] = value;
	}
	try {
		const config = parseJevSettings(readSettingsFile()?.jev);
		env.WORKPILOT_JEV_ENABLED = config.enabled ? "1" : "0";
		env.WORKPILOT_JEV_WORKFLOW_MODES = JSON.stringify(config.workflows ?? {});
		env.WORKPILOT_JEV_MODEL = config.model ?? "jev-latest";
		env.WORKPILOT_JEV_MINIMUM_CONFIDENCE = String(
			config.minimumConfidence ?? 0.8,
		);
		env.WORKPILOT_JEV_TIMEOUT_SECONDS = String(config.timeoutSeconds ?? 5);
		const mode = workflow ? config.workflows?.[workflow] : undefined;
		if (
			workflow &&
			mode !== "bypass" &&
			(mode === "enabled" || config.enabled)
		) {
			const key = getJevService().read();
			if (key) env.TYPESAFE_API_KEY = key;
		}
	} catch {
		env.WORKPILOT_JEV_ENABLED = "invalid";
	}
	return env;
}
