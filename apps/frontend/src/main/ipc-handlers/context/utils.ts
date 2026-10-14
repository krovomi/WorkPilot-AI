import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readSettingsFile } from "../../settings-utils";

export interface EnvironmentVars {
	[key: string]: string;
}

export interface GlobalSettings {
	autoBuildPath?: string;
	globalOpenAIApiKey?: string;
}

/**
 * Get the auto-build source path from settings
 */
export function getAutoBuildSourcePath(): string | null {
	const { autoBuildPath } = loadGlobalSettings();
	return autoBuildPath && existsSync(autoBuildPath) ? autoBuildPath : null;
}

/**
 * Parse .env file content into key-value pairs
 * Handles both Unix and Windows line endings
 */
export function parseEnvFile(envContent: string): EnvironmentVars {
	const vars: EnvironmentVars = {};

	for (const line of envContent.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex > 0) {
			const key = trimmed.substring(0, eqIndex).trim();
			let value = trimmed.substring(eqIndex + 1).trim();

			// Remove quotes if present
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			vars[key] = value;
		}
	}

	return vars;
}

/**
 * Load environment variables from project .env file
 */
export function loadProjectEnvVars(
	projectPath: string,
	autoBuildPath?: string,
): EnvironmentVars {
	if (!autoBuildPath) {
		return {};
	}

	const projectEnvPath = path.join(projectPath, autoBuildPath, ".env");
	if (!existsSync(projectEnvPath)) {
		return {};
	}

	try {
		const envContent = readFileSync(projectEnvPath, "utf-8");
		return parseEnvFile(envContent);
	} catch {
		return {};
	}
}

/**
 * Load global settings from user data directory (secret fields decrypted)
 */
export function loadGlobalSettings(): GlobalSettings {
	return (readSettingsFile() as GlobalSettings | undefined) ?? {};
}
