import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface EnvironmentVars {
	[key: string]: string;
}

export interface GlobalSettings {
	autoBuildPath?: string;
	globalOpenAIApiKey?: string;
}

const settingsPath = path.join(app.getPath("userData"), "settings.json");

/**
 * Get the auto-build source path from settings
 */
export function getAutoBuildSourcePath(): string | null {
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.autoBuildPath && existsSync(settings.autoBuildPath)) {
				return settings.autoBuildPath;
			}
		} catch {
			// Fall through to null
		}
	}
	return null;
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
 * Load global settings from user data directory
 */
export function loadGlobalSettings(): GlobalSettings {
	if (!existsSync(settingsPath)) {
		return {};
	}

	try {
		const settingsContent = readFileSync(settingsPath, "utf-8");
		return JSON.parse(settingsContent);
	} catch {
		return {};
	}
}
