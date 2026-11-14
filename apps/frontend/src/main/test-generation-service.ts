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
import {
	isTestStudioLanguage,
	TDD_SNIPPET_TYPES,
} from "../shared/constants/test-studio-languages";
import type { GeneratedReview } from "../shared/types/generated-review";
import { getAppLanguage } from "./app-language";
import { findOpenReviewCard } from "./generated-review/review-card";
import { MAX_RUN_LOG_LINES } from "./generated-review/review-log";
import {
	findLocalProject,
	openReviewRun,
	type ReviewRun,
	ReviewUnavailableError,
} from "./generated-review/review-run";
import { reviewSubject } from "./generated-review/review-subject";
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

/** What a run that writes is recorded as on its review card. */
interface ReviewStep {
	readonly message: string;
	readonly summary: string;
	readonly log?: readonly string[];
}

const STEP_SUMMARY = {
	unit: { en: "Unit tests for {subject}", fr: "Tests unitaires de {subject}" },
	e2e: { en: "E2E tests: {subject}", fr: "Tests E2E : {subject}" },
	tdd: { en: "TDD tests: {subject}", fr: "Tests TDD : {subject}" },
	packages: { en: "Test packages: {subject}", fr: "Paquets de test : {subject}" },
} as const;

function reviewStep(kind: keyof typeof STEP_SUMMARY, subject: string, message: string): ReviewStep {
	const language = getAppLanguage().toLowerCase().startsWith("fr") ? "fr" : "en";
	return {
		message,
		summary: STEP_SUMMARY[kind][language].replace("{subject}", subject),
	};
}

/** One stage event as a plain log line for the card (no code, no prompt). */
function stageLine(evt: TestGenStageEvent): string {
	const facts = [evt.language, evt.framework, evt.path].filter(Boolean).join(" · ");
	const head = evt.status ? `${evt.stage} (${evt.status})` : evt.stage;
	const tail = evt.detail || facts;
	return tail ? `${head}: ${tail}` : head;
}

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
		const subject = reviewSubject(filePath);
		const run = await this.openRun(projectPath, subject);
		if (!run) return;
		const source = run.map(filePath);
		if (!source) {
			await run.abandon();
			this.emitError({
				message: "The file to test is not inside the project.",
				code: "invalid_input",
				details: filePath,
			});
			return;
		}
		const args = [
			"--action",
			"generate-unit",
			"--file-path",
			source,
			"--coverage-target",
			String(coverageTarget ?? 80),
			"--project-path",
			run.root,
		];
		const existing = run.map(existingTestPath);
		if (existing) {
			args.push("--existing-test-path", existing);
		}
		const dir = run.map(testDir);
		if (dir) {
			args.push("--test-dir", dir);
		}
		if (testLibraries?.length) {
			args.push("--test-libraries", testLibraries.join(","));
		}
		await this.spawnRunner(args, "complete", {
			run,
			step: reviewStep("unit", subject, `test: add generated unit tests for ${subject}`),
		});
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
		const subject = reviewSubject(targetModule || userStory);
		const run = await this.openRun(projectPath, subject);
		if (!run) return;
		const args = [
			"--action",
			"generate-e2e",
			"--user-story",
			userStory,
			"--target-module",
			run.map(targetModule) ?? targetModule,
			"--project-path",
			run.root,
		];
		const dir = run.map(testDir);
		if (dir) {
			args.push("--test-dir", dir);
		}
		if (testLibraries?.length) {
			args.push("--test-libraries", testLibraries.join(","));
		}
		await this.spawnRunner(args, "complete", {
			run,
			step: reviewStep("e2e", subject, `test: add generated e2e tests for ${subject}`),
		});
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
		// Both reach the runner as arguments: only values it knows go through.
		if (!isTestStudioLanguage(language)) {
			this.emitError({
				message: `"${String(language).slice(0, 40)}" is not a language the test generator supports.`,
				code: "invalid_input",
			});
			return;
		}
		const snippet = (TDD_SNIPPET_TYPES as readonly string[]).includes(snippetType)
			? snippetType
			: "function";
		const subject = reviewSubject(description.split("\n")[0] ?? description);
		const run = await this.openRun(projectPath, subject);
		if (!run) return;
		const args = [
			"--action",
			"generate-tdd",
			"--description",
			description,
			"--language",
			language,
			"--snippet-type",
			snippet,
			"--project-path",
			run.root,
		];
		const dir = run.map(testDir);
		if (dir) {
			args.push("--test-dir", dir);
		}
		if (testLibraries?.length) {
			args.push("--test-libraries", testLibraries.join(","));
		}
		await this.spawnRunner(args, "complete", {
			run,
			step: reviewStep("tdd", subject, `test: add generated tdd tests for ${subject}`),
		});
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
		// Where the next run writes: the card waiting for review, when there is one.
		const view = this.reviewView(projectPath);
		const args = [
			"--action",
			"resolve-destination",
			"--file-path",
			view.map(filePath) ?? filePath,
		];
		if (view.root) args.push("--project-path", view.root);
		const existing = view.map(existingTestPath);
		if (existing) args.push("--existing-test-path", existing);

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
		language?: string,
	): Promise<TestLibrarySelection | null> {
		// The packages added by an earlier run live on the card's branch, not in
		// the project folder: read the manifests where the next run writes.
		const view = this.reviewView(projectPath);
		const args = ["--action", "resolve-libraries"];
		if (filePath) args.push("--file-path", view.map(filePath) ?? filePath);
		// TDD and E2E name their language; without it a C# TDD run was offered
		// the libraries of whatever file another tab had open, or Python's.
		if (isTestStudioLanguage(language)) args.push("--language", language);
		if (view.root) args.push("--project-path", view.root);
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
	): Promise<{ report: PackageInstallReport | null; review: GeneratedReview | null }> {
		const subject = selected.join(", ");
		// The manifests are edited on the card's branch, beside the tests they serve.
		const run = await openReviewRun(projectPath, "test-studio", reviewSubject(subject));
		const args = [
			"--action",
			"add-packages",
			"--project-path",
			run.root,
			"--test-libraries",
			selected.join(","),
		];
		const dir = run.map(testDir);
		if (dir) args.push("--test-dir", dir);
		const source = run.map(filePath);
		if (source) args.push("--file-path", source);

		const payload = await this.runQuietly(args, INSTALL_TIMEOUT_MS);
		const report = parsePackageInstallReport(payload?.install);
		if (!report?.installed.length) {
			await run.abandon();
			return { report, review: null };
		}
		const review = await run.finish(
			reviewStep("packages", subject, `test: add test packages ${subject}`),
		);
		return { report, review: review.committed ? review : null };
	}

	/**
	 * Open (or join) the review card a writing run goes to. Null after the
	 * failure has been reported: no card, no write.
	 */
	private async openRun(
		projectPath: string | undefined,
		subject: string,
	): Promise<ReviewRun | null> {
		try {
			return await openReviewRun(projectPath, "test-studio", subject);
		} catch (error) {
			this.emitError({
				message:
					error instanceof ReviewUnavailableError
						? error.message
						: "The review branch for these tests could not be prepared.",
				code: "write_failed",
				stage: "write",
				details:
					error instanceof ReviewUnavailableError
						? error.details
						: error instanceof Error
							? error.message
							: String(error),
			});
			return null;
		}
	}

	/** Where read-only questions look: the open card's worktree, or the project. */
	private reviewView(projectPath: string | undefined): {
		root: string | undefined;
		map: (target: string | undefined) => string | undefined;
	} {
		const project = findLocalProject(projectPath);
		const open = project ? findOpenReviewCard(project, "test-studio") : null;
		if (!project || !open) return { root: projectPath, map: (target) => target };
		const base = path.resolve(project.path);
		return {
			root: open.worktreePath,
			map: (target) => {
				if (!target || !path.isAbsolute(target)) return target;
				const resolved = path.resolve(target);
				return resolved.startsWith(base + path.sep)
					? path.join(open.worktreePath, path.relative(base, resolved))
					: target;
			},
		};
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
		review?: { run: ReviewRun; step: ReviewStep },
	): Promise<void> {
		// Cancel any existing process
		this.cancel();
		// Whatever stops this run before it produced something takes back the
		// card it opened (a joined card keeps everything it had).
		const abandon = () => {
			if (review) void review.run.abandon().catch(() => undefined);
		};

		const backendSource = this.getBackendPath();
		if (!backendSource) {
			this.emitError({
				message:
					"The WorkPilot AI Python backend could not be found, so no generator could be started.",
				code: "backend_missing",
				details: `Looked for runners/test_generation_runner.py under:\n${this.searchedPaths.join("\n")}`,
			});
			abandon();
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
			abandon();
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
		// What the card's log keeps of this run: its stage and status lines.
		const runLog: string[] = [];
		const keep = (line: string) => {
			runLog.push(line);
			if (runLog.length > MAX_RUN_LOG_LINES) runLog.shift();
		};

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
						keep(stageLine(evt as TestGenStageEvent));
						this.emit("progress", evt as TestGenStageEvent);
					}
				} catch (parseErr) {
					console.error("[TestGeneration] Failed to parse event:", parseErr);
				}
			} else if (line.trim()) {
				// Plain progress/status line
				keep(line.trim());
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
			if (code === null) {
				abandon();
				return;
			}

			if (generationResult !== null) {
				if (review) {
					void this.commitToReview(
						{ ...review, step: { ...review.step, log: runLog } },
						generationResult,
						successEvent,
					);
				} else {
					this.emit(successEvent, generationResult);
				}
				return;
			}
			abandon();
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
			abandon();
			reportedFailure = true;
			this.emitError({
				message: `The Python interpreter could not be started: ${err.message}`,
				code: "provider_unavailable",
				details: `command: ${this.pythonPath} ${fullArgs.join(" ")}\ncwd: ${backendSource}`,
			});
		});
	}

	/**
	 * Commit what the runner wrote on the card's branch, then report the run
	 * with the card it went to. The tests exist either way; a commit that
	 * fails is said as such, not as a failed generation.
	 */
	private async commitToReview(
		review: { run: ReviewRun; step: ReviewStep },
		result: unknown,
		successEvent: "result" | "complete",
	): Promise<void> {
		try {
			const card = await review.run.finish(review.step);
			const payload = result && typeof result === "object" ? result : { result };
			this.emit(successEvent, { ...payload, review: card.committed ? card : null });
		} catch (error) {
			// A card this run opened keeps nothing it could not commit.
			await review.run.abandon().catch(() => undefined);
			this.emitError({
				message:
					"The tests were generated on the review branch, but could not be committed there.",
				code: "write_failed",
				stage: "write",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

// Singleton instance
export const testGenerationService = new TestGenerationService();
