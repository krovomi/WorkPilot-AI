/**
 * Subprocess runner utilities for GitHub Python runners
 *
 * Provides a consistent abstraction for spawning and managing Python subprocesses
 * with progress tracking, error handling, and result parsing.
 */

import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { Project } from "../../../../shared/types";
import type {
	AuthFailureInfo,
	BillingFailureInfo,
} from "../../../../shared/types/terminal";
import {
	getOperationRegistry,
	type OperationType,
} from "../../../claude-profile/operation-registry";
import { getClaudeProfileManager } from "../../../claude-profile-manager";
import { findExecutable, isMacOS, isWindows } from "../../../platform";
import { parsePythonCommand } from "../../../python-detector";
import {
	detectAuthFailure,
	detectBillingFailure,
} from "../../../rate-limit-detector";

/**
 * Kill a runner and the processes it started: its process group on Unix
 * (it is spawned detached), its tree through `taskkill` on Windows.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) {
		child.kill(signal);
		return;
	}
	try {
		if (!isWindows()) {
			process.kill(-child.pid, signal);
		} else {
			execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], (err: Error | null) => {
				if (err) console.warn("[SubprocessRunner] taskkill error (process may have already exited):", err.message);
			});
		}
	} catch {
		child.kill(signal);
	}
}

/**
 * Hands each complete line of a stream to `onLine`. A chunk can end in the
 * middle of a line; that part waits for the rest, and `flush` gives the last
 * line when the stream ends without a newline.
 */
function lineReader(onLine: (line: string) => void) {
	let pending = "";
	const emit = (line: string) => {
		const text = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (text.trim()) onLine(text);
	};
	return {
		push(text: string) {
			const combined = pending + text;
			const end = combined.lastIndexOf("\n");
			pending = combined.slice(end + 1);
			if (end >= 0) for (const line of combined.slice(0, end).split("\n")) emit(line);
		},
		flush() {
			emit(pending);
			pending = "";
		},
	};
}

/** Runs `gh` with arguments, without a shell; a failure keeps its output. */
function runGh(gh: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(gh, args, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { output: `${stdout}${stderr}` }));
			else resolve();
		});
	});
}

/**
 * Create a fallback environment for Python subprocesses when no env is provided.
 * This is used for backwards compatibility when callers don't use getRunnerEnv().
 *
 * Includes:
 * - Platform-specific vars needed for shell commands and CLI tools
 * - CLAUDE_ and ANTHROPIC_ prefixed vars for authentication
 */
function createFallbackRunnerEnv(): Record<string, string> {
	// Include platform-specific vars needed for shell commands and CLI tools
	// Windows: SYSTEMROOT, COMSPEC, PATHEXT, WINDIR for shell; USERPROFILE, APPDATA, LOCALAPPDATA for gh CLI auth
	const safeEnvVars = [
		"PATH",
		"HOME",
		"USER",
		"SHELL",
		"LANG",
		"LC_ALL",
		"TERM",
		"TMPDIR",
		"TMP",
		"TEMP",
		"DEBUG",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"WINDIR",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
		"HOMEDRIVE",
		"HOMEPATH",
	];
	const fallbackEnv: Record<string, string> = {};

	for (const key of safeEnvVars) {
		if (process.env[key]) {
			// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
			fallbackEnv[key] = process.env[key]!;
		}
	}

	// Also include any CLAUDE_ or ANTHROPIC_ prefixed vars needed for auth
	for (const [key, value] of Object.entries(process.env)) {
		if ((key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_")) && value) {
			fallbackEnv[key] = value;
		}
	}

	return fallbackEnv;
}

/**
 * Options for running a Python subprocess
 */
export interface SubprocessOptions {
	pythonPath: string;
	args: string[];
	cwd: string;
	onProgress?: (percent: number, message: string, data?: unknown) => void;
	onStdout?: (line: string) => void;
	onStderr?: (line: string) => void;
	onComplete?: (stdout: string, stderr: string) => unknown;
	onError?: (error: string) => void;
	/** Callback when auth failure (401) is detected in output */
	onAuthFailure?: (authFailureInfo: AuthFailureInfo) => void;
	/** Callback when billing/credit exhaustion failure is detected in output */
	onBillingFailure?: (billingFailureInfo: BillingFailureInfo) => void;
	progressPattern?: RegExp;
	/** Additional environment variables to pass to the subprocess */
	env?: Record<string, string>;
	/**
	 * Operation registration for proactive swap support.
	 * If provided, the operation will be registered with the unified OperationRegistry.
	 */
	operationRegistration?: {
		/** Unique operation ID */
		operationId: string;
		/** Operation type for categorization */
		operationType: OperationType;
		/** Optional metadata for the operation */
		metadata?: Record<string, unknown>;
		/**
		 * Function to restart the operation with a new profile.
		 * Should call the original function with refreshed environment.
		 */
		restartFn?: (newProfileId: string) => boolean | Promise<boolean>;
	};
}

/**
 * Result from a subprocess execution
 */
export interface SubprocessResult<T = unknown> {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	data?: T;
	error?: string;
	process?: ChildProcess;
}

/**
 * Run a Python subprocess with progress tracking
 *
 * @param options - Subprocess configuration
 * @returns Object containing the child process and a promise resolving to the result
 */
export function runPythonSubprocess<T = unknown>(
	options: SubprocessOptions,
): { process: ChildProcess; promise: Promise<SubprocessResult<T>> } {
	// Use the environment provided by the caller (from getRunnerEnv()).
	// getRunnerEnv() provides:
	// - pythonEnvManager.getPythonEnv() which includes PYTHONPATH for bundled packages (fixes #139)
	// - API profile environment (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN)
	// - OAuth mode clearing vars
	// - Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN)
	//
	// If no env is provided, fall back to filtered process.env for backwards compatibility.
	// Note: DEBUG is included for PR review debugging (shows LLM thinking blocks).
	let subprocessEnv: Record<string, string>;

	if (options.env) {
		// Caller provided a complete environment (from getRunnerEnv()), use it directly
		subprocessEnv = { ...options.env };
	} else {
		// Fallback: build a filtered environment for backwards compatibility
		subprocessEnv = createFallbackRunnerEnv();
	}

	// Parse Python command to handle paths with spaces (e.g., ~/Library/Application Support/...)
	const [pythonCommand, pythonBaseArgs] = parsePythonCommand(
		options.pythonPath,
	);
	const child = spawn(pythonCommand, [...pythonBaseArgs, ...options.args], {
		cwd: options.cwd,
		env: subprocessEnv,
		// On Unix, detached: true creates a new process group so we can kill all children
		// On Windows, this is not needed (taskkill /T handles it)
		detached: !isWindows(),
	});

	// Register with OperationRegistry for proactive swap support. A run without
	// a restartFn (a PR review is one-shot) gets one that returns false: a
	// profile swap then stops it (SIGTERM, without waiting) and does not restart it.
	if (options.operationRegistration) {
		const { operationId, operationType, metadata, restartFn } = options.operationRegistration;
		const activeProfile = getClaudeProfileManager().getActiveProfile();
		getOperationRegistry().registerOperation(
			operationId,
			operationType,
			activeProfile.id,
			activeProfile.name,
			restartFn || (() => false),
			{
				stopFn: async () => killProcessTree(child, "SIGTERM"),
				metadata: {
					...metadata,
					pythonPath: options.pythonPath,
					cwd: options.cwd,
				},
			},
		);
	}

	const promise = new Promise<SubprocessResult<T>>((resolve) => {
		let stdout = "";
		let stderr = "";
		let authFailureEmitted = false; // Track if we've already emitted an auth failure
		let killedDueToAuthFailure = false; // Track if subprocess was killed due to auth failure
		let billingFailureEmitted = false; // Track if we've already emitted a billing failure
		let killedDueToBillingFailure = false; // Track if subprocess was killed due to billing failure

		// Default progress pattern: [ 30%] message OR [30%] message
		const progressPattern = options.progressPattern ?? /\[\s*(\d+)%\]\s*(.+)/;

		// Helper to check for auth failures in output and emit once
		const checkAuthFailure = (line: string) => {
			if (authFailureEmitted || !options.onAuthFailure) return;

			const authResult = detectAuthFailure(line);
			if (authResult.isAuthFailure) {
				authFailureEmitted = true;

				// Get profile info for display
				const profileManager = getClaudeProfileManager();
				const profile = authResult.profileId
					? profileManager.getProfile(authResult.profileId)
					: profileManager.getActiveProfile();

				const authFailureInfo: AuthFailureInfo = {
					profileId: authResult.profileId || profile?.id || "unknown",
					profileName: profile?.name,
					failureType: authResult.failureType || "unknown",
					message:
						authResult.message ||
						"Authentication failed. Please re-authenticate.",
					originalError: authResult.originalError,
					detectedAt: new Date(),
				};

				try {
					options.onAuthFailure(authFailureInfo);
				} catch (e) {
					console.error("[SubprocessRunner] onAuthFailure callback threw:", e);
				}

				// Kill the subprocess to stop the auth failure spam
				killedDueToAuthFailure = true;

				killProcessTree(child, "SIGKILL");
			}
		};

		// Helper to check for billing/credit failures in output and emit once
		const checkBillingFailure = (line: string) => {
			if (billingFailureEmitted || !options.onBillingFailure) return;

			const billingResult = detectBillingFailure(line);
			if (billingResult.isBillingFailure) {
				billingFailureEmitted = true;

				// Get profile info for display
				const profileManager = getClaudeProfileManager();
				const profile = billingResult.profileId
					? profileManager.getProfile(billingResult.profileId)
					: profileManager.getActiveProfile();

				const billingFailureInfo: BillingFailureInfo = {
					profileId: billingResult.profileId || profile?.id || "unknown",
					profileName: profile?.name,
					failureType: billingResult.failureType || "unknown",
					message:
						billingResult.message ||
						"Billing or credit error. Please check your account.",
					originalError: billingResult.originalError,
					detectedAt: new Date(),
				};

				try {
					options.onBillingFailure(billingFailureInfo);
				} catch (e) {
					console.error(
						"[SubprocessRunner] onBillingFailure callback threw:",
						e,
					);
				}

				// Kill the subprocess to stop the billing failure spam
				killedDueToBillingFailure = true;

				killProcessTree(child, "SIGKILL");
			}
		};

		const stdoutLines = lineReader((line) => {
			// Call custom stdout handler
			options.onStdout?.(line);

			// Check for auth and billing failures in real-time (each emitted once)
			checkAuthFailure(line);
			checkBillingFailure(line);

			// Parse progress updates
			const match = line.match(progressPattern);
			if (match && options.onProgress) {
				options.onProgress(parseInt(match[1], 10), match[2].trim());
			}
		});
		const stderrLines = lineReader((line) => {
			options.onStderr?.(line);
			checkAuthFailure(line);
			checkBillingFailure(line);
		});

		child.stdout.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			stdout += text;
			stdoutLines.push(text);
		});

		child.stderr.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			stderr += text;
			stderrLines.push(text);
		});

		child.on("close", (code: number | null) => {
			stdoutLines.flush();
			stderrLines.flush();
			// Treat null exit code (killed with SIGKILL) as failure, not success
			const exitCode = code ?? -1;

			// Unregister from OperationRegistry when process exits
			if (options.operationRegistration) {
				getOperationRegistry().unregisterOperation(
					options.operationRegistration.operationId,
				);
			}

			// Note: Auth failure detection now happens in real-time during stdout/stderr processing
			// (see checkAuthFailure helper above). This ensures the modal appears immediately,
			// not just when the process exits.

			// Check if subprocess was killed due to auth failure
			if (killedDueToAuthFailure) {
				resolve({
					success: false,
					exitCode: exitCode,
					stdout,
					stderr,
					error: "Authentication failed. Please re-authenticate.",
				});
				return;
			}

			// Check if subprocess was killed due to billing/credit failure
			if (killedDueToBillingFailure) {
				resolve({
					success: false,
					exitCode: exitCode,
					stdout,
					stderr,
					error: "Billing or credit error. Please check your account.",
				});
				return;
			}

			if (exitCode === 0) {
				try {
					const data = options.onComplete?.(stdout, stderr);
					resolve({
						success: true,
						exitCode,
						stdout,
						stderr,
						data: data as T,
					});
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : "Unknown error";
					options.onError?.(errorMessage);
					resolve({
						success: false,
						exitCode,
						stdout,
						stderr,
						error: errorMessage,
					});
				}
			} else {
				const errorMessage = stderr || `Process failed with code ${exitCode}`;
				options.onError?.(errorMessage);
				resolve({
					success: false,
					exitCode,
					stdout,
					stderr,
					error: errorMessage,
				});
			}
		});

		child.on("error", (err: Error) => {
			options.onError?.(err.message);
			resolve({
				success: false,
				exitCode: -1,
				stdout,
				stderr,
				error: err.message,
			});
		});
	});

	return { process: child, promise };
}

/**
 * Get the Python path for a project's backend
 * Cross-platform: uses Scripts/python.exe on Windows, bin/python on Unix
 */
export function getPythonPath(backendPath: string): string {
	return isWindows()
		? path.join(backendPath, ".venv", "Scripts", "python.exe")
		: path.join(backendPath, ".venv", "bin", "python");
}

/**
 * Get the GitHub runner path for a project
 */
export function getRunnerPath(backendPath: string): string {
	return path.join(backendPath, "runners", "github", "runner.py");
}

/**
 * The app's backend that holds a forge runner (`runners/github/runner.py`,
 * `runners/gitlab/runner.py`), or null. It is looked for where the app runs
 * from, never in the project's folder: the project is what the runner works
 * on, not where the app's code lives.
 */
export function findAppBackendPath(runner: string): string | null {
	let appPath: string | null = null;
	try {
		appPath = app.getAppPath();
	} catch {
		// No Electron app here (a test that mocks electron without it)
	}

	// Same locations as agent-process.ts
	const possiblePaths = [
		// Dev mode: apps/frontend/out/main -> apps/backend
		path.resolve(import.meta.dirname, "..", "..", "..", "backend"),
		// Alternative: from app root -> apps/backend
		appPath ? path.resolve(appPath, "..", "backend") : null,
		// If running from repo root with apps structure
		path.resolve(process.cwd(), "apps", "backend"),
	].filter((p): p is string => p !== null);

	return possiblePaths.find((p) => fs.existsSync(path.join(p, runner))) ?? null;
}

/** The app's backend that holds the GitHub runner, or null. */
export function getBackendPath(): string | null {
	return findAppBackendPath(path.join("runners", "github", "runner.py"));
}

/**
 * Comprehensive validation result for GitHub module
 */
export interface GitHubModuleValidation {
	valid: boolean;
	runnerAvailable: boolean;
	ghCliInstalled: boolean;
	ghAuthenticated: boolean;
	pythonEnvValid: boolean;
	error?: string;
	backendPath?: string;
}

/**
 * Comprehensive async validation of GitHub automation module
 *
 * Checks:
 * 1. runner.py exists in the app's backend (dev repo or production install)
 * 2. gh CLI is installed
 * 3. gh CLI is authenticated
 * 4. Python virtual environment is set up
 *
 * @param _project - The project the review will run on; the runner is the app's
 * @returns Detailed validation result with specific error messages
 */
export async function validateGitHubModule(
	_project?: Project,
): Promise<GitHubModuleValidation> {
	const result: GitHubModuleValidation = {
		valid: false,
		runnerAvailable: false,
		ghCliInstalled: false,
		ghAuthenticated: false,
		pythonEnvValid: false,
	};

	// 1. Check runner.py location
	const backendPath = getBackendPath();
	if (!backendPath) {
		result.error =
			"GitHub automation module not installed: the app's backend has no GitHub runner.";
		return result;
	}

	result.backendPath = backendPath;
	result.runnerAvailable = true;

	// 2. Check gh CLI installation (cross-platform)
	const gh = findExecutable("gh");
	if (!gh) {
		const installInstructions = isWindows()
			? "winget install --id GitHub.cli"
			: isMacOS()
				? "brew install gh"
				: "See https://cli.github.com/";
		result.error = `GitHub CLI (gh) is not installed. Install it with:\n  ${installInstructions}`;
		return result;
	}
	result.ghCliInstalled = true;

	// 3. Check gh authentication: `gh auth status` exits non-zero when not
	// logged in. Any other failure (a network issue) still counts as logged in.
	try {
		await runGh(gh, ["auth", "status"]);
	} catch (error) {
		const { output } = error as { output: string };
		if (output.includes("not logged in") || output.includes("not authenticated")) {
			result.error = "GitHub CLI is not authenticated. Run:\n  gh auth login";
			return result;
		}
	}
	result.ghAuthenticated = true;

	// 4. Check Python virtual environment (cross-platform)
	const venvPath = getPythonPath(backendPath);
	result.pythonEnvValid = fs.existsSync(venvPath);

	if (!result.pythonEnvValid) {
		result.error = `Python virtual environment not found. Run setup:\n  cd ${backendPath}\n  uv venv && uv pip install -r requirements.txt`;
		return result;
	}

	// All checks passed
	result.valid = true;
	return result;
}

/**
 * Parse JSON from stdout (finds JSON block in output)
 */
export function parseJSONFromOutput<T>(stdout: string): T {
	// Look for JSON after the "JSON Output" marker to avoid debug output
	const jsonMarker = "JSON Output";
	const markerIndex = stdout.lastIndexOf(jsonMarker);
	const searchStart = markerIndex >= 0 ? markerIndex : 0;

	// Try to find JSON array first, then object
	const arrayStart = stdout.indexOf("[", searchStart);
	const objectStart = stdout.indexOf("{", searchStart);

	let jsonStart = -1;
	let jsonEnd = -1;

	// Determine if it's an array or object (whichever comes first)
	if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
		// It's an array
		jsonStart = arrayStart;
		jsonEnd = stdout.lastIndexOf("]");
	} else if (objectStart >= 0) {
		// It's an object
		jsonStart = objectStart;
		jsonEnd = stdout.lastIndexOf("}");
	}

	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		let jsonStr = stdout.substring(jsonStart, jsonEnd + 1);

		// Clean up debug output prefixes and markdown code blocks
		jsonStr = jsonStr
			.split("\n")
			.map((line) => {
				// Remove common debug prefixes
				const debugPrefixes = [
					/^\[GitHub AutoFix\] STDOUT:\s*/,
					/^\[GitHub AutoFix\] STDERR:\s*/,
					/^\[[A-Za-z][^\]]*\]\s*/, // Any other bracketed prefix (must start with letter to avoid matching JSON arrays)
				];

				let cleaned = line;
				for (const prefix of debugPrefixes) {
					cleaned = cleaned.replace(prefix, "");
				}
				return cleaned;
			})
			.filter((line) => {
				// Remove markdown code block markers
				const trimmed = line.trim();
				return trimmed !== "```json" && trimmed !== "```";
			})
			.join("\n");

		try {
			// Debug: log the exact string we're trying to parse
			return JSON.parse(jsonStr);
		} catch (_parseError) {
			// Provide a more helpful error message with details
			throw new Error(
				"Failed to parse JSON response from backend. The analysis completed but the response format was invalid.",
			);
		}
	}

	throw new Error("No JSON found in output");
}

/**
 * Build standard GitHub runner arguments
 */
export function buildRunnerArgs(
	runnerPath: string,
	projectPath: string,
	command: string,
	additionalArgs: string[] = [],
	options?: {
		model?: string;
		thinkingLevel?: string;
		/** The flag that names the project folder (the GitLab runner's is `--project-dir`). */
		projectFlag?: string;
	},
): string[] {
	const args = [runnerPath, options?.projectFlag ?? "--project", projectPath];

	if (options?.model) {
		args.push("--model", options.model);
	}

	if (options?.thinkingLevel) {
		args.push("--thinking-level", options.thinkingLevel);
	}

	args.push(command);
	args.push(...additionalArgs);

	return args;
}
