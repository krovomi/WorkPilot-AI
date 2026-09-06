import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
	PackageInstallReport,
	TestDestination,
	TestGenerationError,
	TestGenErrorCode,
	TestGenStageEvent,
	TestLibrarySelection,
} from "../shared/types/test-generation";
import {
	normalizeTestGenerationError,
	parsePackageInstallReport,
	parseTestDestination,
	parseTestLibrarySelection,
} from "../shared/types/test-generation";
import { getRunnerEnv } from "./ipc-handlers/github/utils/runner-env";

/**
 * Service for test generation
 *
 * Spawns the Python test_generation_runner.py process and streams output
 * back to the renderer via events.
 *
 * Events emitted:
 * - 'status' (status: string) — Status update message
 * - 'error' (error: TestGenerationError) — Structured failure: message, code,
 *   the stage it died on, and the redacted technical text behind it
 * - 'result' (result: unknown) — Coverage analysis result (analyze-coverage action)
 * - 'complete' (result: unknown) — Generation complete with structured result
 * - 'progress' (event: TestGenStageEvent) — Live pipeline stage (detect/read/generate/write/done)
 * - 'code' (delta: string) — A chunk of clean generated test code, streamed live
 */

export type { TestGenStageEvent };

/** Strip ANSI escapes and box-drawing noise so stderr is readable in the UI. */
function cleanProcessOutput(raw: string): string {
	return (
		raw
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips ANSI escape codes from error output
			.replaceAll(/\u001b\[[0-9;]*[A-Za-z]/g, "")
			.replaceAll(/[\u2500-\u257F]/g, "")
			.trim()
	);
}

/**
 * Classify a process-level failure from its stderr.
 *
 * The runner reports everything it can catch itself. What lands here is what it
 * could not: an interpreter that died before our code ran, a missing dependency,
 * a killed process. Guessing a code from the text is still better than "exit 1",
 * because the code is what turns the panel into an instruction.
 */
function classifyProcessFailure(text: string): TestGenErrorCode {
	const haystack = text.toLowerCase();
	const has = (...needles: string[]) => needles.some((n) => haystack.includes(n));
	if (has("rate limit", "rate_limit", "429", "too many requests")) return "rate_limit";
	if (has("quota", "billing", "credit balance", "insufficient_quota")) return "quota";
	if (has("401", "403", "unauthorized", "authentication", "oauth", "credential", "api key"))
		return "auth";
	if (has("timed out", "timeout")) return "timeout";
	if (has("connection", "network", "getaddrinfo", "ssl", "certificate", "proxy"))
		return "network";
	if (has("modulenotfounderror", "importerror", "no module named", "command not found"))
		return "provider_unavailable";
	if (has("permissionerror", "read-only file system", "no space left")) return "write_failed";
	return "runner_crashed";
}

/** stdout prefix carrying a runner success payload. */
const RESULT_PREFIX = "__TEST_GENERATION_RESULT__:";

/** A pre-flight that outlives this is broken, not slow. */
const RESOLVE_TIMEOUT_MS = 15_000;

/** `dotnet add package` restores from the network; give it room. */
const INSTALL_TIMEOUT_MS = 240_000;

export class TestGenerationService extends EventEmitter {
	private activeProcess: ChildProcess | null = null;
	private pythonPath: string = "python";
	private backendPath: string | null = null;
	/** Where getBackendPath() last looked — quoted verbatim when it found nothing. */
	private searchedPaths: string[] = [];

	/**
	 * Configure paths for Python and backend
	 */
	configure(pythonPath?: string, backendPath?: string): void {
		if (pythonPath) {
			this.pythonPath = pythonPath;
		}
		if (backendPath) {
			this.backendPath = backendPath;
		}
	}

	/**
	 * Get the backend path, trying common locations
	 */
	private getBackendPath(): string | null {
		if (this.backendPath) return this.backendPath;

		const possiblePaths = [
			// Production install (same pattern as context-aware-snippets-service)
			path.join(
				app.getPath("userData"),
				"..",
				"auto-claude",
				"apps",
				"backend",
			),
			// Dev mode via app.getAppPath() (same pattern as quality-handlers)
			path.join(app.getAppPath(), "..", "..", "apps", "backend"),
			// Dev mode via process.cwd()
			path.join(process.cwd(), "apps", "backend"),
			// Fallback: app is inside apps/frontend, go up
			path.join(app.getAppPath(), "..", "backend"),
		];

		this.searchedPaths = possiblePaths;
		for (const p of possiblePaths) {
			const runnerPath = path.join(p, "runners", "test_generation_runner.py");
			if (existsSync(runnerPath)) {
				this.backendPath = p;
				return p;
			}
		}

		console.error("[TestGeneration] Tried paths:", possiblePaths);
		return null;
	}

	/** Emit one structured failure, stamped with the time it was observed. */
	private emitError(error: Omit<TestGenerationError, "at">): void {
		this.emit("error", { ...error, at: Date.now() } satisfies TestGenerationError);
	}

	/**
	 * Cancel any active generation
	 */
	cancel(): boolean {
		if (!this.activeProcess) return false;
		this.activeProcess.kill();
		this.activeProcess = null;
		return true;
	}

	/**
	 * Analyze test coverage for a file
	 */
	async analyzeCoverage(
		filePath: string,
		existingTestPath?: string,
		projectPath?: string,
	): Promise<void> {
		const args = ["--action", "analyze-coverage", "--file-path", filePath];
		if (existingTestPath) {
			args.push("--existing-test-path", existingTestPath);
		}
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		await this.spawnRunner(args, "result");
	}

	/**
	 * Generate unit tests for a file
	 */
	async generateUnitTests(
		filePath: string,
		existingTestPath?: string,
		coverageTarget?: number,
		projectPath?: string,
		testDir?: string,
		testLibraries?: string[],
	): Promise<void> {
		const args = [
			"--action",
			"generate-unit",
			"--file-path",
			filePath,
			"--coverage-target",
			String(coverageTarget ?? 80),
		];
		if (existingTestPath) {
			args.push("--existing-test-path", existingTestPath);
		}
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		if (testDir) {
			args.push("--test-dir", testDir);
		}
		if (testLibraries?.length) {
			args.push("--test-libraries", testLibraries.join(","));
		}
		await this.spawnRunner(args, "complete");
	}

	/**
	 * Generate E2E tests from a user story
	 */
	async generateE2ETests(
		userStory: string,
		targetModule: string,
		projectPath?: string,
		testDir?: string,
		testLibraries?: string[],
	): Promise<void> {
		const args = [
			"--action",
			"generate-e2e",
			"--user-story",
			userStory,
			"--target-module",
			targetModule,
		];
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		if (testDir) {
			args.push("--test-dir", testDir);
		}
		if (testLibraries?.length) {
			args.push("--test-libraries", testLibraries.join(","));
		}
		await this.spawnRunner(args, "complete");
	}

	/**
	 * Generate TDD tests from a description
	 */
	async generateTDDTests(
		description: string,
		language: string,
		snippetType: string,
		projectPath?: string,
		testDir?: string,
		testLibraries?: string[],
	): Promise<void> {
		const args = [
			"--action",
			"generate-tdd",
			"--description",
			description,
			"--language",
			language,
			"--snippet-type",
			snippetType,
		];
		if (projectPath) {
			args.push("--project-path", projectPath);
		}
		if (testDir) {
			args.push("--test-dir", testDir);
		}
		if (testLibraries?.length) {
			args.push("--test-libraries", testLibraries.join(","));
		}
		await this.spawnRunner(args, "complete");
	}

	/**
	 * Ask the backend where the tests for `filePath` would be written.
	 *
	 * Runs before a generation, so the question "which directory?" is settled
	 * while it is still free to ask — no provider, no network, just the
	 * project's layout on disk. Resolves to null when the runner could not
	 * answer: the caller then generates without a chosen directory, which is
	 * what it did before this existed.
	 *
	 * Deliberately not routed through `spawnRunner`: that one cancels the
	 * active generation and reports through the shared event stream, and a
	 * pre-flight question must do neither.
	 */
	async resolveDestination(
		filePath: string,
		projectPath?: string,
		existingTestPath?: string,
	): Promise<TestDestination | null> {
		const args = ["--action", "resolve-destination", "--file-path", filePath];
		if (projectPath) args.push("--project-path", projectPath);
		if (existingTestPath) args.push("--existing-test-path", existingTestPath);

		const payload = await this.runQuietly(args, RESOLVE_TIMEOUT_MS);
		return parseTestDestination(payload?.destination);
	}

	/**
	 * Ask the backend what the tests for `filePath` would be written against.
	 *
	 * The catalogue, what the project's manifests already reference, and the
	 * selection that follows — filesystem only, so the picker can open with the
	 * project's own stack ticked without paying for a model call.
	 */
	async resolveLibraries(
		filePath: string,
		projectPath?: string,
		selected?: string[],
	): Promise<TestLibrarySelection | null> {
		const args = ["--action", "resolve-libraries"];
		if (filePath) args.push("--file-path", filePath);
		if (projectPath) args.push("--project-path", projectPath);
		if (selected?.length) args.push("--test-libraries", selected.join(","));

		const payload = await this.runQuietly(args, RESOLVE_TIMEOUT_MS);
		return parseTestLibrarySelection(payload?.libraries);
	}

	/**
	 * Add the selected-but-absent packages to the project's test project.
	 *
	 * Separate from generation on purpose: writing a test file must not edit
	 * someone's `.csproj`, so this only ever runs from a button the user
	 * pressed after seeing which packages are missing. It can take a while —
	 * `dotnet add package` restores — hence its own, longer timeout.
	 */
	async addPackages(
		selected: string[],
		projectPath: string,
		testDir?: string,
		filePath?: string,
	): Promise<PackageInstallReport | null> {
		const args = [
			"--action",
			"add-packages",
			"--project-path",
			projectPath,
			"--test-libraries",
			selected.join(","),
		];
		if (testDir) args.push("--test-dir", testDir);
		if (filePath) args.push("--file-path", filePath);

		const payload = await this.runQuietly(args, INSTALL_TIMEOUT_MS);
		return parsePackageInstallReport(payload?.install);
	}

	/**
	 * Run one runner action to completion and hand back its result payload.
	 *
	 * Deliberately not `spawnRunner`: that one cancels the active generation
	 * and reports through the shared event stream, and a question asked before
	 * (or beside) a generation must do neither. Resolves to null on any
	 * failure — these are pre-flights, and a pre-flight that cannot answer must
	 * not stop the run the user actually asked for.
	 */
	private async runQuietly(
		args: string[],
		timeoutMs: number,
	): Promise<Record<string, unknown> | null> {
		const backendSource = this.getBackendPath();
		if (!backendSource) return null;

		const runnerPath = path.join(
			backendSource,
			"runners",
			"test_generation_runner.py",
		);
		if (!existsSync(runnerPath)) return null;

		const processEnv = await getRunnerEnv({ PYTHONPATH: backendSource });

		return await new Promise<Record<string, unknown> | null>((resolve) => {
			const proc = spawn(this.pythonPath, [runnerPath, ...args], {
				cwd: backendSource,
				env: processEnv,
			});
			let stdout = "";
			let settled = false;
			const finish = (value: Record<string, unknown> | null) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const timer = setTimeout(() => {
				proc.kill();
				finish(null);
			}, timeoutMs);

			proc.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString("utf-8");
			});
			proc.on("error", () => {
				clearTimeout(timer);
				finish(null);
			});
			proc.on("close", () => {
				clearTimeout(timer);
				const line = stdout
					.split("\n")
					.find((entry) => entry.startsWith(RESULT_PREFIX));
				if (!line) return finish(null);
				try {
					finish(JSON.parse(line.slice(RESULT_PREFIX.length)));
				} catch {
					finish(null);
				}
			});
		});
	}

	/**
	 * Spawn the runner script and handle output parsing
	 * @param args - Arguments to pass to the runner (after the script path)
	 * @param successEvent - Event to emit when the result is received ('result' or 'complete')
	 */
	private async spawnRunner(
		args: string[],
		successEvent: "result" | "complete",
	): Promise<void> {
		// Cancel any existing process
		this.cancel();

		const backendSource = this.getBackendPath();
		if (!backendSource) {
			this.emitError({
				message:
					"The WorkPilot AI Python backend could not be found, so no generator could be started.",
				code: "backend_missing",
				details: `Looked for runners/test_generation_runner.py under:\n${this.searchedPaths.join("\n")}`,
			});
			return;
		}

		const runnerPath = path.join(
			backendSource,
			"runners",
			"test_generation_runner.py",
		);
		if (!existsSync(runnerPath)) {
			this.emitError({
				message:
					"The test generator script is missing from the backend installation.",
				code: "backend_missing",
				details: `Expected file: ${runnerPath}`,
			});
			return;
		}

		// Build clean environment using the same pattern as other runners.
		// This ensures the correct Claude profile (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN)
		// is used and prevents host IDE env vars (e.g. Windsurf) from redirecting the SDK
		// to the wrong API provider.
		const processEnv = await getRunnerEnv({ PYTHONPATH: backendSource });

		const fullArgs = [runnerPath, ...args];

		const proc = spawn(this.pythonPath, fullArgs, {
			cwd: backendSource,
			env: processEnv,
		});

		this.activeProcess = proc;

		let stderrOutput = "";
		let generationResult: unknown = null;
		// The runner reports each failure twice — __TG_ERROR__ (structured) then
		// __TEST_GENERATION_ERROR__ (message only) — so an older frontend still
		// gets something. Having consumed the rich one, ignore its echo, and stay
		// silent afterwards: the close handler must not append "exit code 1" to a
		// failure that has already been explained properly.
		let reportedFailure = false;
		// Buffer partial lines: a single stdout 'data' chunk can split a line
		// mid-way (common now that we stream many small __TG_EVENT__ lines), so
		// we only process complete '\n'-terminated lines and keep the remainder.
		let stdoutBuffer = "";

		const handleLine = (line: string): void => {
			if (line.startsWith(RESULT_PREFIX)) {
				try {
					const jsonStr = line.substring(RESULT_PREFIX.length);
					generationResult = JSON.parse(jsonStr);
					this.emit("status", "Test generation complete");
				} catch (parseErr) {
					console.error("[TestGeneration] Failed to parse result:", parseErr);
				}
			} else if (line.startsWith("__TG_ERROR__:")) {
				try {
					const payload = JSON.parse(line.substring("__TG_ERROR__:".length));
					reportedFailure = true;
					this.emitError(
						normalizeTestGenerationError(
							payload,
							"Test generation failed.",
						) as Omit<TestGenerationError, "at">,
					);
				} catch (parseErr) {
					console.error("[TestGeneration] Failed to parse error:", parseErr);
				}
			} else if (line.startsWith("__TEST_GENERATION_ERROR__:")) {
				// Only reached when __TG_ERROR__ was absent or unparseable.
				if (reportedFailure) return;
				reportedFailure = true;
				this.emitError({
					message: line.substring("__TEST_GENERATION_ERROR__:".length).trim(),
					code: "unknown",
				});
			} else if (line.startsWith("__TG_EVENT__:")) {
				try {
					const evt = JSON.parse(line.substring("__TG_EVENT__:".length));
					if (evt?.type === "code" && typeof evt.delta === "string") {
						this.emit("code", evt.delta);
					} else if (evt?.type === "stage") {
						this.emit("progress", evt as TestGenStageEvent);
					}
				} catch (parseErr) {
					console.error("[TestGeneration] Failed to parse event:", parseErr);
				}
			} else if (line.trim()) {
				// Plain progress/status line
				this.emit("status", line.trim());
			}
		};

		proc.stdout?.on("data", (data: Buffer) => {
			stdoutBuffer += data.toString("utf-8");
			let nl = stdoutBuffer.indexOf("\n");
			while (nl !== -1) {
				handleLine(stdoutBuffer.slice(0, nl));
				stdoutBuffer = stdoutBuffer.slice(nl + 1);
				nl = stdoutBuffer.indexOf("\n");
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			stderrOutput = (stderrOutput + text).slice(-5000);
			console.error("[TestGeneration]", text);
		});

		proc.on("close", (code) => {
			if (this.activeProcess === proc) {
				this.activeProcess = null;
			}

			// Flush any trailing line that wasn't newline-terminated.
			if (stdoutBuffer.trim()) {
				handleLine(stdoutBuffer);
				stdoutBuffer = "";
			}

			// code === null means killed by signal (e.g. cancel() was called) — ignore silently
			if (code === null) return;

			if (generationResult !== null) {
				this.emit(successEvent, generationResult);
				return;
			}
			// The runner already explained itself on stdout — anything we add here
			// would only bury it under a generic exit-code message.
			if (reportedFailure) return;

			const clean = cleanProcessOutput(stderrOutput);
			if (code === 0) {
				// Exited cleanly but produced no result: the process ran and said
				// nothing, which is a different problem from a crash.
				this.emitError({
					message:
						"The generator finished without producing any tests, and reported no reason.",
					code: "no_output",
					exitCode: code,
					details: clean || undefined,
				});
				return;
			}
			this.emitError({
				message: `The test generator stopped unexpectedly (exit code ${code}).`,
				code: classifyProcessFailure(clean),
				exitCode: code ?? undefined,
				// Keep the tail: a Python traceback puts the cause on its last lines.
				details: clean.slice(-4000) || undefined,
			});
		});

		proc.on("error", (err) => {
			if (this.activeProcess === proc) {
				this.activeProcess = null;
			}
			reportedFailure = true;
			this.emitError({
				message: `The Python interpreter could not be started: ${err.message}`,
				code: "provider_unavailable",
				details: `command: ${this.pythonPath} ${fullArgs.join(" ")}\ncwd: ${backendSource}`,
			});
		});
	}
}

// Singleton instance
export const testGenerationService = new TestGenerationService();
