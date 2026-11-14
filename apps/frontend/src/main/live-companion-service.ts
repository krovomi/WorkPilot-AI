import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { app } from "electron";
import type {
	CompanionConfig,
	CompanionError,
	CompanionState,
	FileChangeEvent,
	LiveSuggestion,
	TakeoverProposal,
} from "../shared/types/live-companion";
import { getAppLanguage } from "./app-language";
import {
	buildIgnoredPredicate,
	DEFAULT_IGNORE_PATTERNS,
	DEFAULT_WATCH_PATTERNS,
	detectLanguage,
	isLegacyIgnorePatterns,
	isLegacyWatchPatterns,
	readChangeContent,
} from "./live-companion-watch";
import { pythonRunnerEnv } from "./utils/python-runner-env";

const CONFIG_DIR = path.join(os.homedir(), ".workpilot", "live_companion");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const SUGGESTIONS_FILE = path.join(CONFIG_DIR, "suggestions.json");
const TAKEOVERS_FILE = path.join(CONFIG_DIR, "takeovers.json");

const EVENT_PREFIX = "LIVE_COMPANION_EVENT:";
/** A file needs this many saves before a pause on it reads as "stuck". */
const TAKEOVER_MIN_CHANGES = 3;
const TAKEOVER_CHECK_MS = 15_000;

const DEFAULT_CONFIG: CompanionConfig = {
	enabled: false,
	watch_debounce_ms: 1500,
	suggestion_enabled: true,
	takeover_enabled: true,
	takeover_inactivity_seconds: 120,
	min_suggestion_confidence: 0.5,
	max_suggestions_per_file: 5,
	watch_patterns: [...DEFAULT_WATCH_PATTERNS],
	ignore_patterns: [...DEFAULT_IGNORE_PATTERNS],
};

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof CompanionConfig)[];

function samePath(a: string | undefined, b: string): boolean {
	if (!a) return false;
	return path.resolve(a) === path.resolve(b);
}

function readJson<T>(file: string, fallback: T): T {
	try {
		if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")) as T;
	} catch {
		/* unreadable: start over */
	}
	return fallback;
}

/**
 * Live Development Companion Service
 *
 * Watches the project folder (chokidar), sends the debounced changes to
 * `runners/live_companion_runner.py`, which asks the selected provider for
 * suggestions, and proposes a takeover when the developer stops after
 * several edits of a file. Suggestions and proposals are stored per project.
 *
 * Events emitted:
 * - 'state-changed' (state: CompanionState): also carries `last_error`, the
 *   reason the last start or analysis failed, which the page shows
 * - 'suggestion' (suggestion: LiveSuggestion)
 * - 'takeover-proposal' (proposal: TakeoverProposal)
 * - 'file-change' (event: FileChangeEvent)
 *
 * No 'error' event: an EventEmitter throws on an 'error' nobody listens to,
 * which made a failed start reject instead of saying why.
 */
export class LiveCompanionService extends EventEmitter {
	private watcher: FSWatcher | null = null;
	private pythonPath: string = "python";
	private autoBuildSourcePath: string | null = null;
	private activeProcess: ChildProcess | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingChanges: FileChangeEvent[] = [];
	private takeoverCheckInterval: ReturnType<typeof setInterval> | null = null;
	private fileActivityMap: Map<
		string,
		{ lastChange: number; changeCount: number }
	> = new Map();
	private lastActivity = 0;
	private config: CompanionConfig | null = null;

	private state: CompanionState = {
		active: false,
		watching_project: "",
		files_watched: 0,
		changes_detected: 0,
		suggestions_generated: 0,
		suggestions_accepted: 0,
		takeovers_proposed: 0,
		takeovers_accepted: 0,
		started_at: "",
		last_change_at: "",
		analyzing: false,
		last_error: null,
	};

	/**
	 * Configure paths
	 */
	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) this.pythonPath = pythonPath;
		if (autoBuildSourcePath) this.autoBuildSourcePath = autoBuildSourcePath;
	}

	/**
	 * Get current companion state
	 */
	getState(): CompanionState {
		return { ...this.state };
	}

	/**
	 * Get companion config: the defaults, overlaid by what the user changed.
	 */
	getConfig(): CompanionConfig {
		const stored = readJson<Partial<CompanionConfig>>(CONFIG_FILE, {});
		const config: CompanionConfig = { ...DEFAULT_CONFIG };
		for (const key of CONFIG_KEYS) {
			if (stored[key] !== undefined) {
				(config as unknown as Record<string, unknown>)[key] = stored[key];
			}
		}
		if (isLegacyWatchPatterns(stored.watch_patterns)) {
			config.watch_patterns = [...DEFAULT_WATCH_PATTERNS];
		}
		if (isLegacyIgnorePatterns(stored.ignore_patterns)) {
			config.ignore_patterns = [...DEFAULT_IGNORE_PATTERNS];
		}
		return config;
	}

	/**
	 * Update companion config. Only the fields the user changed are written,
	 * so later defaults (a new stack, a new ignored folder) still reach them.
	 * A running companion applies the change at once.
	 */
	updateConfig(updates: Partial<CompanionConfig>): CompanionConfig {
		const stored = readJson<Record<string, unknown>>(CONFIG_FILE, {});
		for (const key of CONFIG_KEYS) {
			const value = (updates as Record<string, unknown>)[key];
			if (value === undefined) continue;
			if (typeof value !== typeof DEFAULT_CONFIG[key]) continue;
			if (Array.isArray(DEFAULT_CONFIG[key]) !== Array.isArray(value)) continue;
			stored[key] = value;
		}
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2), "utf-8");
		const config = this.getConfig();
		this.config = config;
		if (this.state.active) this.applyTakeoverTimer(config);
		return config;
	}

	/**
	 * Start watching a project directory
	 */
	async start(projectDir: string): Promise<boolean> {
		if (this.state.active) {
			this.stop();
		}

		const config = this.getConfig();
		this.config = config;

		try {
			const watcher = watch(projectDir, {
				ignored: buildIgnoredPredicate(
					projectDir,
					config.watch_patterns,
					config.ignore_patterns,
				),
				persistent: true,
				ignoreInitial: true,
				awaitWriteFinish: {
					stabilityThreshold: 300,
					pollInterval: 100,
				},
			});
			this.watcher = watcher;

			const relative = (file: string) =>
				path.relative(projectDir, path.resolve(projectDir, file));
			watcher.on("change", (file: string) =>
				this.handleFileChange(projectDir, relative(file), "modified"),
			);
			watcher.on("add", (file: string) =>
				this.handleFileChange(projectDir, relative(file), "created"),
			);
			watcher.on("unlink", (file: string) =>
				this.handleFileChange(projectDir, relative(file), "deleted"),
			);
			watcher.on("error", (error: unknown) =>
				this.setError({
					message: error instanceof Error ? error.message : String(error),
					code: "watch_failed",
				}),
			);

			this.state = {
				...this.state,
				active: true,
				watching_project: projectDir,
				started_at: new Date().toISOString(),
				changes_detected: 0,
				suggestions_generated: 0,
				suggestions_accepted: 0,
				takeovers_proposed: 0,
				takeovers_accepted: 0,
				last_change_at: "",
				analyzing: false,
				last_error: null,
			};
			this.lastActivity = Date.now();
			this.applyTakeoverTimer(config);

			this.emit("state-changed", this.getState());
			return true;
		} catch (error) {
			this.setError({
				message: (error as Error).message,
				code: "watch_failed",
			});
			return false;
		}
	}

	/**
	 * Stop watching
	 */
	stop(): void {
		if (this.watcher) {
			void this.watcher.close();
			this.watcher = null;
		}

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		if (this.takeoverCheckInterval) {
			clearInterval(this.takeoverCheckInterval);
			this.takeoverCheckInterval = null;
		}

		if (this.activeProcess) {
			this.activeProcess.kill();
			this.activeProcess = null;
		}

		this.pendingChanges = [];
		this.fileActivityMap.clear();

		this.state = {
			...this.state,
			active: false,
			analyzing: false,
		};

		this.emit("state-changed", this.getState());
	}

	/**
	 * The active suggestions of `projectDir` (of the watched project when
	 * none is named).
	 */
	getSuggestions(projectDir?: string): LiveSuggestion[] {
		const project = projectDir || this.state.watching_project;
		const data = readJson<{ suggestions?: LiveSuggestion[] }>(
			SUGGESTIONS_FILE,
			{},
		);
		return (data.suggestions || []).filter(
			(s) => s.status === "active" && samePath(s.project_dir, project),
		);
	}

	/**
	 * Dismiss a suggestion
	 */
	dismissSuggestion(suggestionId: string): boolean {
		return this.updateSuggestionStatus(suggestionId, "dismissed");
	}

	/**
	 * Mark a suggestion as handled: the page turned it into a Kanban task.
	 */
	applySuggestion(suggestionId: string): boolean {
		const result = this.updateSuggestionStatus(suggestionId, "applied");
		if (result) {
			this.state.suggestions_accepted++;
			this.emit("state-changed", this.getState());
		}
		return result;
	}

	/**
	 * The pending takeover proposals of `projectDir` (of the watched project
	 * when none is named).
	 */
	getTakeovers(projectDir?: string): TakeoverProposal[] {
		const project = projectDir || this.state.watching_project;
		const data = readJson<{ takeovers?: TakeoverProposal[] }>(
			TAKEOVERS_FILE,
			{},
		);
		return (data.takeovers || []).filter(
			(t) => t.status === "proposed" && samePath(t.project_dir, project),
		);
	}

	/**
	 * Mark a takeover as accepted: the page turned it into a Kanban task.
	 */
	acceptTakeover(proposalId: string): boolean {
		const result = this.updateTakeoverStatus(proposalId, "accepted");
		if (result) {
			this.state.takeovers_accepted++;
			this.emit("state-changed", this.getState());
		}
		return result;
	}

	/**
	 * Decline a takeover proposal
	 */
	declineTakeover(proposalId: string): boolean {
		return this.updateTakeoverStatus(proposalId, "declined");
	}

	// ── Private methods ──────────────────────────────────────────

	private currentConfig(): CompanionConfig {
		if (!this.config) this.config = this.getConfig();
		return this.config;
	}

	private setError(error: Omit<CompanionError, "at">): void {
		this.state = {
			...this.state,
			last_error: { ...error, at: new Date().toISOString() },
		};
		this.emit("state-changed", this.getState());
	}

	private applyTakeoverTimer(config: CompanionConfig): void {
		if (config.takeover_enabled && !this.takeoverCheckInterval) {
			this.takeoverCheckInterval = setInterval(() => {
				this.checkForTakeover(this.currentConfig());
			}, TAKEOVER_CHECK_MS);
		} else if (!config.takeover_enabled && this.takeoverCheckInterval) {
			clearInterval(this.takeoverCheckInterval);
			this.takeoverCheckInterval = null;
		}
	}

	private handleFileChange(
		projectDir: string,
		filePath: string,
		changeType: FileChangeEvent["change_type"],
	): void {
		if (!filePath || filePath.startsWith("..")) return;
		const now = Date.now();
		this.lastActivity = now;

		const existing = this.fileActivityMap.get(filePath);
		if (changeType === "deleted") {
			this.fileActivityMap.delete(filePath);
		} else {
			this.fileActivityMap.set(filePath, {
				lastChange: now,
				changeCount: (existing?.changeCount ?? 0) + 1,
			});
		}

		this.state.changes_detected++;
		this.state.last_change_at = new Date(now).toISOString();

		const content = readChangeContent(projectDir, filePath, changeType);
		const event: FileChangeEvent = {
			file_path: filePath,
			change_type: changeType,
			diff: content.text,
			content_kind: content.kind,
			language: detectLanguage(filePath),
			timestamp: new Date(now).toISOString(),
		};

		this.emit("file-change", event);
		this.emit("state-changed", this.getState());

		const config = this.currentConfig();
		if (!config.suggestion_enabled || !event.diff.trim()) return;

		this.pendingChanges.push(event);
		this.scheduleAnalysis(projectDir, config.watch_debounce_ms);
	}

	private scheduleAnalysis(projectDir: string, delayMs: number): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			void this.analyzePendingChanges(projectDir);
		}, delayMs);
	}

	private async analyzePendingChanges(projectDir: string): Promise<void> {
		if (this.pendingChanges.length === 0) return;
		// One analysis at a time; the changes wait and run when it ends.
		if (this.activeProcess) return;

		const autoBuildSource = this.getAutoBuildSourcePath();
		if (!autoBuildSource) {
			this.setError({
				message: "runners/live_companion_runner.py not found",
				code: "backend_missing",
			});
			return;
		}
		const runnerPath = path.join(
			autoBuildSource,
			"runners",
			"live_companion_runner.py",
		);

		const changes = [...this.pendingChanges];
		this.pendingChanges = [];
		const config = this.currentConfig();

		const tmpFile = path.join(
			os.tmpdir(),
			`workpilot_companion_${process.pid}_${Date.now()}.json`,
		);
		writeFileSync(tmpFile, JSON.stringify({ changes }), "utf-8");

		const args = [
			runnerPath,
			"analyze-batch",
			"--project-dir",
			projectDir,
			"--changes-file",
			tmpFile,
			"--min-confidence",
			String(config.min_suggestion_confidence),
			"--max-per-file",
			String(config.max_suggestions_per_file),
			"--language",
			getAppLanguage(),
		];

		let processEnv: Record<string, string>;
		try {
			processEnv = await this.buildProcessEnvironment();
		} catch (error) {
			this.removeTmp(tmpFile);
			this.setError({ message: (error as Error).message, code: "env_failed" });
			return;
		}
		if (!this.state.active || !samePath(this.state.watching_project, projectDir)) {
			this.removeTmp(tmpFile);
			return;
		}

		const proc = spawn(this.pythonPath, args, {
			cwd: autoBuildSource,
			env: processEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.activeProcess = proc;
		this.state = { ...this.state, analyzing: true };
		this.emit("state-changed", this.getState());

		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString("utf-8");
		});
		proc.stderr?.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString("utf-8")).slice(-4000);
		});

		const finish = (code: number | null, spawnError?: Error) => {
			if (this.activeProcess !== proc) return;
			this.activeProcess = null;
			this.removeTmp(tmpFile);
			this.state = { ...this.state, analyzing: false };
			this.handleRunnerOutput(projectDir, stdout, stderr, code, spawnError);
			if (this.state.active && this.pendingChanges.length > 0) {
				this.scheduleAnalysis(projectDir, 0);
			}
		};
		proc.on("close", (code) => finish(code));
		proc.on("error", (error) => finish(null, error));
	}

	private handleRunnerOutput(
		projectDir: string,
		stdout: string,
		stderr: string,
		exitCode: number | null,
		spawnError?: Error,
	): void {
		let sawEvent = false;
		for (const line of stdout.split("\n")) {
			if (!line.startsWith(EVENT_PREFIX)) continue;
			let event: {
				type?: string;
				message?: string;
				data?: {
					suggestions?: LiveSuggestion[];
					errors?: Omit<CompanionError, "at">[];
					message?: string;
					code?: string;
					provider?: string;
					model?: string;
				};
			};
			try {
				event = JSON.parse(line.substring(EVENT_PREFIX.length));
			} catch {
				continue;
			}
			sawEvent = true;
			if (event.type === "complete") {
				for (const raw of event.data?.suggestions ?? []) {
					const suggestion = { ...raw, project_dir: projectDir };
					this.state.suggestions_generated++;
					this.storeSuggestion(suggestion);
					this.emit("suggestion", suggestion);
				}
				const failed = event.data?.errors?.[0];
				this.state = {
					...this.state,
					last_error: failed
						? { ...failed, at: new Date().toISOString() }
						: null,
				};
				this.emit("state-changed", this.getState());
			} else if (event.type === "error") {
				this.setError({
					message: event.data?.message || event.message || "analysis failed",
					code: event.data?.code || "analysis_failed",
					provider: event.data?.provider,
					model: event.data?.model,
				});
			}
		}
		if (sawEvent) return;
		const tail = stderr.trim().split("\n").slice(-3).join("\n");
		this.setError({
			message:
				spawnError?.message ||
				tail ||
				`live_companion_runner.py exited with code ${exitCode}`,
			code: spawnError ? "python_missing" : "runner_crashed",
		});
	}

	private removeTmp(file: string): void {
		try {
			unlinkSync(file);
		} catch {
			/* already gone */
		}
	}

	/**
	 * A takeover is proposed when the whole project has been quiet for the
	 * configured time right after several edits of one file: the developer
	 * stopped there. Moving on to another file is not being stuck, so the
	 * pause is measured on the project, and the file is the last one edited.
	 */
	private checkForTakeover(config: CompanionConfig): void {
		if (!config.takeover_enabled || !this.state.active) return;
		const now = Date.now();
		const inactive = now - this.lastActivity;
		if (inactive < config.takeover_inactivity_seconds * 1000) return;

		let lastFile: string | null = null;
		let lastActivity: { lastChange: number; changeCount: number } | null = null;
		for (const [filePath, activity] of this.fileActivityMap.entries()) {
			if (!lastActivity || activity.lastChange > lastActivity.lastChange) {
				lastFile = filePath;
				lastActivity = activity;
			}
		}
		// One proposal per pause: the next one needs new edits.
		this.fileActivityMap.clear();
		if (!lastFile || !lastActivity) return;
		if (lastActivity.changeCount < TAKEOVER_MIN_CHANGES) return;

		const inactiveSeconds = Math.floor((now - lastActivity.lastChange) / 1000);
		const proposal: TakeoverProposal = {
			proposal_id: `tkv-${now.toString(36)}`,
			file_path: lastFile,
			reason: "inactivity",
			// The page writes the sentence in the app language from the fields.
			description: "",
			inactivity_seconds: inactiveSeconds,
			complexity_score: 0,
			status: "proposed",
			ai_plan: "",
			ai_result_summary: "",
			created_at: new Date(now).toISOString(),
			change_count: lastActivity.changeCount,
			project_dir: this.state.watching_project,
		};

		this.storeTakeover(proposal);
		this.state.takeovers_proposed++;
		this.emit("takeover-proposal", proposal);
		this.emit("state-changed", this.getState());
	}

	private storeSuggestion(suggestion: LiveSuggestion): void {
		try {
			mkdirSync(CONFIG_DIR, { recursive: true });
			const data = readJson<{ suggestions: LiveSuggestion[] }>(
				SUGGESTIONS_FILE,
				{ suggestions: [] },
			);
			data.suggestions = [...(data.suggestions || []), suggestion].slice(-200);
			writeFileSync(SUGGESTIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch {
			/* ignore */
		}
	}

	private storeTakeover(proposal: TakeoverProposal): void {
		try {
			mkdirSync(CONFIG_DIR, { recursive: true });
			const data = readJson<{ takeovers: TakeoverProposal[] }>(
				TAKEOVERS_FILE,
				{ takeovers: [] },
			);
			data.takeovers = [...(data.takeovers || []), proposal].slice(-50);
			writeFileSync(TAKEOVERS_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch {
			/* ignore */
		}
	}

	private updateSuggestionStatus(
		suggestionId: string,
		status: LiveSuggestion["status"],
	): boolean {
		try {
			if (!existsSync(SUGGESTIONS_FILE)) return false;
			const data = JSON.parse(readFileSync(SUGGESTIONS_FILE, "utf-8"));
			const suggestion = (data.suggestions || []).find(
				(s: LiveSuggestion) => s.suggestion_id === suggestionId,
			);
			if (!suggestion) return false;
			suggestion.status = status;
			writeFileSync(SUGGESTIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
			return true;
		} catch {
			return false;
		}
	}

	private updateTakeoverStatus(
		proposalId: string,
		status: TakeoverProposal["status"],
	): boolean {
		try {
			if (!existsSync(TAKEOVERS_FILE)) return false;
			const data = JSON.parse(readFileSync(TAKEOVERS_FILE, "utf-8"));
			const takeover = (data.takeovers || []).find(
				(t: TakeoverProposal) => t.proposal_id === proposalId,
			);
			if (!takeover) return false;
			takeover.status = status;
			writeFileSync(TAKEOVERS_FILE, JSON.stringify(data, null, 2), "utf-8");
			return true;
		} catch {
			return false;
		}
	}

	private getAutoBuildSourcePath(): string | null {
		if (this.autoBuildSourcePath) return this.autoBuildSourcePath;

		const validatePath = (p: string): boolean =>
			existsSync(path.join(p, "runners", "live_companion_runner.py"));

		const possiblePaths = [
			...(app.isPackaged ? [path.join(process.resourcesPath, "backend")] : []),
			path.resolve(import.meta.dirname, "..", "..", "..", "backend"),
			path.resolve(app.getAppPath(), "..", "backend"),
			path.resolve(process.cwd(), "apps", "backend"),
		];

		for (const p of possiblePaths) {
			if (validatePath(p)) {
				this.autoBuildSourcePath = p;
				return p;
			}
		}

		return null;
	}

	/**
	 * The runner's environment: the provider the user chose and its key, the
	 * Claude sign-in only when that provider needs it, and no other credential
	 * of the app (`pythonRunnerEnv`).
	 */
	private buildProcessEnvironment(): Promise<Record<string, string>> {
		return pythonRunnerEnv(this.getAutoBuildSourcePath() ?? "");
	}
}

// Singleton
export const liveCompanionService = new LiveCompanionService();
