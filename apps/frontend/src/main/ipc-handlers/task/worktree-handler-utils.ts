/**
 * Helpers shared by the worktree handler modules. Split out of
 * worktree-handlers.ts (plan of 29 October, N8 A2).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { minimatch } from "minimatch";
import {
	DEFAULT_APP_SETTINGS,
	DEFAULT_FEATURE_MODELS,
	DEFAULT_FEATURE_THINKING,
	MODEL_ID_MAP,
	THINKING_BUDGET_MAP,
} from "../../../shared/constants";
import type { AppSettings } from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
/**
 * Extract the last well-formed JSON object found in a multi-line stdout
 * blob. The Python backend interleaves DEBUG log lines with its final
 * `print(json.dumps(result))`, so JSON.parse on the whole stream fails.
 *
 * Walks the lines bottom-up, returns the first one that parses as an
 * object (not a primitive). Returns null when no parseable object is
 * found — callers should treat that as an error.
 */
export function extractLastJsonObject(stdout: string): Record<string, unknown> | null {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Not valid JSON on this line — keep walking up.
		}
	}
	return null;
}

// Timeout for PR creation operations (2 minutes for network operations)
export const PR_CREATION_TIMEOUT_MS = 120000;

/**
 * Read utility feature settings (for commit message, merge resolver) from settings file
 */
export function getUtilitySettings(): {
	model: string;
	modelId: string;
	thinkingLevel: string;
	thinkingBudget: number | null;
} {
	const settingsPath = path.join(app.getPath("userData"), "settings.json");

	try {
		if (existsSync(settingsPath)) {
			const content = readFileSync(settingsPath, "utf-8");
			const settings: AppSettings = {
				...DEFAULT_APP_SETTINGS,
				...JSON.parse(content),
			};

			// Get utility-specific settings
			const featureModels = settings.featureModels || DEFAULT_FEATURE_MODELS;
			const featureThinking =
				settings.featureThinking || DEFAULT_FEATURE_THINKING;

			const model = featureModels.utility || DEFAULT_FEATURE_MODELS.utility;
			const thinkingLevel =
				featureThinking.utility || DEFAULT_FEATURE_THINKING.utility;

			return {
				model,
				modelId: MODEL_ID_MAP[model] || MODEL_ID_MAP.haiku,
				thinkingLevel,
				thinkingBudget:
					thinkingLevel in THINKING_BUDGET_MAP
						? THINKING_BUDGET_MAP[thinkingLevel]
						: THINKING_BUDGET_MAP.low,
			};
		}
	} catch (error) {
		// Log parse errors to help diagnose corrupted settings
		console.warn("[getUtilitySettings] Failed to parse settings.json:", error);
	}

	// Return defaults if settings file doesn't exist or fails to parse
	return {
		model: DEFAULT_FEATURE_MODELS.utility,
		modelId: MODEL_ID_MAP[DEFAULT_FEATURE_MODELS.utility],
		thinkingLevel: DEFAULT_FEATURE_THINKING.utility,
		thinkingBudget: THINKING_BUDGET_MAP[DEFAULT_FEATURE_THINKING.utility],
	};
}

/**
 * Check if a repository is misconfigured as bare but has source files.
 * If so, automatically fix the configuration by unsetting core.bare.
 *
 * This can happen when git worktree operations incorrectly set bare=true,
 * or when users manually misconfigure the repository.
 *
 * @param projectPath - Path to check and potentially fix
 * @returns true if fixed, false if no fix needed or not fixable
 */
export function fixMisconfiguredBareRepo(projectPath: string): boolean {
	try {
		// Check if bare=true is set
		const bareConfig = execFileSync(
			getToolPath("git"),
			["config", "--get", "core.bare"],
			{ cwd: projectPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		)
			.trim()
			.toLowerCase();

		if (bareConfig !== "true") {
			return false; // Not marked as bare, nothing to fix
		}

		// Check if there are source files (indicating misconfiguration)
		// A truly bare repo would only have git internals, not source code
		// This covers multiple ecosystems: JS/TS, Python, Rust, Go, Java, C#, etc.
		//
		// Markers are separated into exact matches and glob patterns for efficiency.
		// Exact matches use existsSync() directly, while glob patterns use minimatch
		// against a cached directory listing.
		const EXACT_MARKERS = [
			// JavaScript/TypeScript ecosystem
			"package.json",
			"apps",
			"src",
			// Python ecosystem
			"pyproject.toml",
			"setup.py",
			"requirements.txt",
			"Pipfile",
			// Rust ecosystem
			"Cargo.toml",
			// Go ecosystem
			"go.mod",
			"go.sum",
			"cmd",
			"main.go",
			// Java/JVM ecosystem
			"pom.xml",
			"build.gradle",
			"build.gradle.kts",
			// Ruby ecosystem
			"Gemfile",
			"Rakefile",
			// PHP ecosystem
			"composer.json",
			// General project markers
			"Makefile",
			"CMakeLists.txt",
			"README.md",
			"LICENSE",
		];

		const GLOB_MARKERS = [
			// .NET/C# ecosystem - patterns that need glob matching
			"*.csproj",
			"*.sln",
			"*.fsproj",
		];

		// Check exact matches first (fast path)
		const hasExactMatch = EXACT_MARKERS.some((marker) =>
			existsSync(path.join(projectPath, marker)),
		);

		if (hasExactMatch) {
			// Found a project marker, proceed to fix
		} else {
			// Check glob patterns - read directory once and cache for all patterns
			let directoryFiles: string[] | null = null;
			const MAX_FILES_TO_CHECK = 500; // Limit to avoid reading huge directories

			const hasGlobMatch = GLOB_MARKERS.some((pattern) => {
				// Validate pattern - only support simple glob patterns for security
				if (pattern.includes("..") || pattern.includes("/")) {
					console.warn(`[GIT] Unsupported glob pattern ignored: ${pattern}`);
					return false;
				}

				// Lazy-load directory listing, cached across patterns
				if (directoryFiles === null) {
					try {
						const allFiles = readdirSync(projectPath);
						// Limit to first N entries to avoid performance issues
						directoryFiles = allFiles.slice(0, MAX_FILES_TO_CHECK);
						if (allFiles.length > MAX_FILES_TO_CHECK) {
							console.warn(
								`[GIT] Directory has ${allFiles.length} entries, checking only first ${MAX_FILES_TO_CHECK}`,
							);
						}
					} catch (error) {
						// Log the error for debugging instead of silently swallowing
						console.warn(
							`[GIT] Failed to read directory ${projectPath}:`,
							error instanceof Error ? error.message : String(error),
						);
						directoryFiles = [];
					}
				}

				// Use minimatch for proper glob pattern matching
				return directoryFiles.some((file) =>
					minimatch(file, pattern, { nocase: true }),
				);
			});

			if (!hasGlobMatch) {
				return false; // Legitimately bare repo
			}
		}

		// Fix the misconfiguration
		console.warn(
			"[GIT] Detected misconfigured bare repository with source files. Auto-fixing by unsetting core.bare...",
		);
		execFileSync(getToolPath("git"), ["config", "--unset", "core.bare"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		console.warn(
			"[GIT] Fixed: core.bare has been unset. Git operations should now work correctly.",
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a path is a valid git working tree (not a bare repository).
 * Returns true if the path is inside a git repository with a working tree.
 *
 * NOTE: This is a pure check with no side-effects. If you need to fix
 * misconfigured bare repos before an operation, call fixMisconfiguredBareRepo()
 * explicitly before calling this function.
 *
 * @param projectPath - Path to check
 * @returns true if it's a valid working tree, false if bare or not a git repo
 */
export function isGitWorkTree(projectPath: string): boolean {
	try {
		// Use git rev-parse --is-inside-work-tree which returns "true" for working trees
		// and fails for bare repos or non-git directories
		const result = execFileSync(
			getToolPath("git"),
			["rev-parse", "--is-inside-work-tree"],
			{ cwd: projectPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		return result.trim() === "true";
	} catch {
		// Not a working tree (could be bare repo or not a git repo at all)
		return false;
	}
}
