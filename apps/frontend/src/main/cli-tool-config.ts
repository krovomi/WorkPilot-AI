/**
 * The user's CLI tool paths (Settings → Paths, the Claude and Copilot
 * pickers), as the CLI tool manager reads them.
 */

/**
 * User configuration for CLI tool paths
 * Maps to settings stored in settings.json
 */
export interface ToolConfig {
	pythonPath?: string;
	gitPath?: string;
	githubCLIPath?: string;
	gitlabCLIPath?: string;
	claudePath?: string;
	copilotPath?: string;
}

const TOOL_CONFIG_KEYS = [
	"pythonPath",
	"gitPath",
	"githubCLIPath",
	"gitlabCLIPath",
	"claudePath",
	"copilotPath",
] as const satisfies readonly (keyof ToolConfig)[];

/** The tool paths the app settings hold; an empty path means "detect". */
export function toolConfigFromSettings(
	settings: Partial<Record<keyof ToolConfig, unknown>>,
): ToolConfig {
	const config: ToolConfig = {};
	for (const key of TOOL_CONFIG_KEYS) {
		const value = settings[key];
		if (typeof value === "string" && value) config[key] = value;
	}
	return config;
}

/** Same paths, an empty or missing one counting as "detect". */
export function sameToolConfig(a: ToolConfig, b: ToolConfig): boolean {
	return TOOL_CONFIG_KEYS.every(
		(key) => (a[key] || undefined) === (b[key] || undefined),
	);
}
