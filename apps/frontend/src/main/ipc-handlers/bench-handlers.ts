/**
 * Repo bench IPC handlers.
 *
 * Finished cards are replayed from the commit before them, once per engine
 * (provider × model × effort), and judged by the tests they landed with,
 * which the replaying agent never sees (docs/architecture/repo-bench.md).
 *
 * The backend runner (`runners/bench_runner.py`) finds each card's target
 * commit, calibrates the judge, makes one isolated copy per build outside the
 * project, judges each build once it ended, and keeps the table. The builds
 * in between are ordinary `run.py` processes, started here through the agent
 * manager (`--direct` in the copy, the project's own environment through
 * `envProjectPath`), a few at a time. They are not Kanban tasks: their events
 * stop here (`isBenchBuild`).
 *
 * The renderer names a project, cards and engines; never a path. Card ids
 * must be finished tasks of that project, and a copy the runner names must
 * lie in the bench's data folder before a build is started in it.
 *
 * Channels:
 *   invoke BENCH_CANDIDATES (projectId)                         → IPCResult<BenchCandidate[]>
 *   invoke BENCH_STATUS     (projectId)                         → IPCResult<BenchStatus>
 *   invoke BENCH_START      (projectId, specIds, engines, commits?) → IPCResult<BenchStatus>
 *   invoke BENCH_DISCARD    (projectId, runId)                  → IPCResult<BenchStatus>
 *   send   BENCH_EVENT      (projectId, BenchStatus)
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	BenchBuild,
	BenchCandidate,
	BenchCase,
	BenchEngine,
	BenchManifest,
	BenchStatus,
	BenchTableRow,
	IPCResult,
	Project,
	Task,
} from "../../shared/types";
import type { AgentManager } from "../agent";
import { appLog } from "../app-logger";
import { getAugmentedEnv } from "../env-utils";
import { projectStore } from "../project-store";
import { parsePythonCommand } from "../python-detector";
import { pythonEnvManager } from "../python-env-manager";
import { envWithoutCredentials } from "../utils/child-env";

const RUNNER = "bench_runner.py";
export const MAX_CASES = 20;
export const MAX_ENGINES = 4;
const MAX_CANDIDATES = 60;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
/** Between two builds' starts: each spawns a backend and reads the provider. */
const START_SPACING_MS = 1500;
/** A build restarted by the profile swap is running again within this delay. */
const RESTART_GRACE_MS = 2000;
const DISCARD_WAIT_MS = 15_000;
const RUNS_SHOWN = 10;

const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFORT = /^[a-z][a-z_-]{0,31}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{6}$/;
const BUILD_ID = /^b\d{1,3}$/;
const TASK_ID = /^bench-\d{8}t\d{6}-[0-9a-f]{6}-b\d{1,3}$/;
const FINISHED: ReadonlySet<Task["status"]> = new Set(["done", "pr_created"]);

type Outcome = "ended" | "not-started" | "interrupted";

interface Active {
	project: Project;
	runId: string;
	busy?: BenchStatus["busy"];
	error?: string;
	queue: BenchBuild[];
	/** taskId → the build and when its process started. */
	running: Map<string, { buildId: string; startedAt: string }>;
	/** Builds stopped by a rate limit or a failed sign-in: not the model's doing. */
	interrupted: Set<string>;
	pumping: boolean;
	discarding: boolean;
	/** Runner calls of this run, one after the other: one writer of the manifest. */
	chain: Promise<unknown>;
}

const active = new Map<string, Active>();
/** Every bench build started since the app opened: their events are not a task's. */
const benchTaskIds = new Set<string>();

/** Whether `taskId` is a repo bench build, not a board task. */
export function isBenchBuild(taskId: string): boolean {
	return TASK_ID.test(taskId) && benchTaskIds.has(taskId);
}

export function concurrency(): number {
	const raw = Number.parseInt(process.env.WORKPILOT_BENCH_CONCURRENCY ?? "", 10);
	if (!Number.isFinite(raw)) return DEFAULT_CONCURRENCY;
	return Math.min(MAX_CONCURRENCY, Math.max(1, raw));
}

/** The bench's data folder, as the runner computes it (bench/layout.py). */
export function benchRoot(): string {
	const configured = (process.env.WORKPILOT_DATA_DIR ?? "").trim();
	return path.resolve(configured || path.join(os.homedir(), ".workpilot"), "bench");
}

export function insideBenchRoot(copy: unknown): copy is string {
	if (typeof copy !== "string" || !path.isAbsolute(copy)) return false;
	const relative = path.relative(benchRoot(), path.resolve(copy));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function sanitizeEngines(raw: unknown): BenchEngine[] | string {
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ENGINES) {
		return `Choose between 1 and ${MAX_ENGINES} engines`;
	}
	const engines: BenchEngine[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") return "Each engine must be an object";
		const { provider, model, effort } = item as Record<string, unknown>;
		if (typeof provider !== "string" || !PROVIDER.test(provider)) {
			return "An engine has no valid provider";
		}
		if (
			typeof model !== "string" ||
			!model.trim() ||
			model.length > 200 ||
			[...model].some((c) => c.charCodeAt(0) < 32)
		) {
			return "An engine has no valid model";
		}
		if (typeof effort !== "string" || !EFFORT.test(effort)) {
			return "An engine has no valid effort";
		}
		const engine = { provider, model: model.trim(), effort };
		if (
			engines.some(
				(e) =>
					e.provider === engine.provider &&
					e.model === engine.model &&
					e.effort === engine.effort,
			)
		) {
			return "The same engine is listed twice";
		}
		engines.push(engine);
	}
	return engines;
}

/** Card ids from the renderer: finished tasks of the project, 1 to 20. */
export function sanitizeSpecIds(raw: unknown, tasks: Task[]): string[] | string {
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CASES) {
		return `Choose between 1 and ${MAX_CASES} cards`;
	}
	const finished = new Set(
		tasks.filter((t) => FINISHED.has(t.status)).map((t) => t.specId),
	);
	const specs: string[] = [];
	for (const spec of raw) {
		if (typeof spec !== "string" || !SPEC_ID.test(spec)) return "Invalid card id";
		if (!finished.has(spec)) return "Only finished cards can be replayed";
		if (!specs.includes(spec)) specs.push(spec);
	}
	return specs;
}

/** Commits the person gave, for cards whose target was not found. */
export function sanitizeCommits(
	raw: unknown,
	specs: string[],
): Record<string, string> | string {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) return "Invalid commits";
	const commits: Record<string, string> = {};
	for (const [spec, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!specs.includes(spec)) return "A commit is given for a card not chosen";
		if (typeof value !== "string") return "Invalid commit";
		const sha = value.trim().toLowerCase();
		if (!sha) continue;
		if (!COMMIT.test(sha)) return "A commit is 7 to 64 hexadecimal characters";
		commits[spec] = sha;
	}
	return commits;
}

export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
	const suffix = Math.floor(Math.random() * 0xffffff)
		.toString(16)
		.padStart(6, "0");
	return `${stamp}-${suffix}`;
}

/** The runner's one JSON line. */
export function parseRunnerOutput(stdout: string): { data?: unknown; error?: string } {
	const lines = stdout.trim().split("\n").reverse();
	for (const line of lines) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			const payload = JSON.parse(text) as Record<string, unknown>;
			if (typeof payload.error === "string") return { error: payload.error };
			if ("data" in payload) return { data: payload.data };
		} catch {
			// Not ours.
		}
	}
	return { error: "The bench runner gave no answer" };
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/**
 * The runner needs git, the test toolchains and the backend, no credential:
 * it calls no model. Its test runs build their own, smaller environment
 * again (bench/judge.py).
 */
function runnerEnv(backend: string): Record<string, string> {
	const pythonEnv = pythonEnvManager.getPythonEnv();
	const entries = [backend, ...(pythonEnv.PYTHONPATH ?? "").split(path.delimiter)]
		.map((entry) => entry.trim())
		.filter(Boolean);
	return envWithoutCredentials(
		{ ...getAugmentedEnv(), ...pythonEnv },
		{
			PYTHONPATH: [...new Set(entries)].join(path.delimiter),
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONUTF8: "1",
		},
	);
}

async function runRunner(
	command: "discover" | "prepare" | "judge" | "discard",
	project: Project,
	extra: string[],
): Promise<{ data?: unknown; error?: string }> {
	const pythonPath = pythonEnvManager.getPythonPath();
	if (!pythonPath) return { error: "Python environment not ready" };
	const backend = backendPath();
	const [exe, baseArgs] = parsePythonCommand(pythonPath);
	const args = [
		...baseArgs,
		path.join(backend, "runners", RUNNER),
		command,
		"--project-dir",
		project.path,
		...extra,
	];
	return new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exe, args, { cwd: backend, env: runnerEnv(backend) });
		} catch (error) {
			resolve({ error: error instanceof Error ? error.message : "Failed to start" });
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appLog.debug("[BENCH]", chunk.toString().trim());
		});
		child.on("error", (err) => resolve({ error: err.message }));
		child.on("close", () => resolve(parseRunnerOutput(stdout)));
	});
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function benchDir(project: Project): string {
	return path.join(project.path, ".workpilot", "bench");
}

/** A manifest as the renderer sees it: no path to a copy. */
export function forRenderer(manifest: BenchManifest): BenchManifest {
	return {
		...manifest,
		builds: manifest.builds.map(({ copy: _copy, ...build }) => ({ ...build, copy: "" })),
	};
}

function readRuns(project: Project): BenchManifest[] {
	let names: string[] = [];
	try {
		names = readdirSync(path.join(benchDir(project), "runs"));
	} catch {
		return [];
	}
	return names
		.filter((name) => RUN_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
		.sort()
		.reverse()
		.slice(0, RUNS_SHOWN)
		.map((name) => readJson(path.join(benchDir(project), "runs", name)))
		.filter(
			(data): data is BenchManifest =>
				!!data &&
				typeof data === "object" &&
				Array.isArray((data as BenchManifest).builds) &&
				Array.isArray((data as BenchManifest).cases),
		);
}

function readTable(project: Project): BenchTableRow[] {
	const data = readJson(path.join(benchDir(project), "results.json")) as {
		table?: unknown;
	} | null;
	return Array.isArray(data?.table) ? (data.table as BenchTableRow[]) : [];
}

function finishedCards(project: Project): Task[] {
	return projectStore
		.getTasks(project.id)
		.filter((t) => FINISHED.has(t.status) && SPEC_ID.test(t.specId));
}

export function registerBenchHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	const status = (project: Project): BenchStatus => {
		const run = active.get(project.id);
		return {
			activeRunId: run?.runId ?? null,
			...(run?.busy && { busy: run.busy }),
			...(run?.error && { error: run.error }),
			running: run ? [...run.running.keys()] : [],
			queued: run?.queue.length ?? 0,
			concurrency: concurrency(),
			runs: readRuns(project).map((manifest) => ({
				...forRenderer(manifest),
				// A run this app session does not drive: the app stopped under it.
				stale:
					(manifest.phase === "running" || manifest.phase === "calibrating") &&
					manifest.runId !== run?.runId,
			})),
			table: readTable(project),
		};
	};

	const publish = (project: Project) => {
		getMainWindow()?.webContents.send(IPC_CHANNELS.BENCH_EVENT, project.id, status(project));
	};

	const serially = <T>(run: Active, step: () => Promise<T>): Promise<T> => {
		const next = run.chain.then(step, step);
		run.chain = next.catch(() => undefined);
		return next;
	};

	const finish = (run: Active) => {
		if (active.get(run.project.id) === run) active.delete(run.project.id);
		publish(run.project);
	};

	const judge = (run: Active, buildId: string, outcome: Outcome, code: number | null, startedAt: string) => {
		const endedAt = new Date().toISOString();
		void serially(run, async () => {
			const result = await runRunner("judge", run.project, [
				"--run-id",
				run.runId,
				"--build",
				buildId,
				"--outcome",
				outcome,
				...(code === null ? [] : ["--exit-code", String(code)]),
				"--started-at",
				startedAt,
				"--ended-at",
				endedAt,
			]);
			if (result.error) {
				appLog.warn("[BENCH] judge failed:", result.error);
				run.error = result.error;
			}
			const manifest = result.data as BenchManifest | undefined;
			if (manifest?.phase === "done" && !run.discarding) finish(run);
			else publish(run.project);
		});
	};

	const buildEnded = (taskId: string, outcome: Outcome, code: number | null) => {
		for (const run of active.values()) {
			const entry = run.running.get(taskId);
			if (!entry) continue;
			run.running.delete(taskId);
			const final: Outcome =
				run.interrupted.has(taskId) || run.discarding || (outcome === "ended" && code === null)
					? "interrupted"
					: outcome;
			judge(run, entry.buildId, final, code, entry.startedAt);
			void pump(run);
			publish(run.project);
			return;
		}
	};

	const pump = async (run: Active) => {
		if (run.pumping) return;
		run.pumping = true;
		try {
			while (!run.discarding && run.queue.length > 0 && run.running.size < concurrency()) {
				const build = run.queue.shift() as BenchBuild;
				const startedAt = new Date().toISOString();
				if (
					!TASK_ID.test(build.taskId) ||
					!BUILD_ID.test(build.id) ||
					!SPEC_ID.test(build.caseId) ||
					!insideBenchRoot(build.copy)
				) {
					appLog.warn("[BENCH] refused a build the runner described oddly:", build.id);
					judge(run, build.id, "not-started", null, startedAt);
					continue;
				}
				benchTaskIds.add(build.taskId);
				run.running.set(build.taskId, { buildId: build.id, startedAt });
				publish(run.project);
				try {
					await agentManager.startTaskExecution(
						build.taskId,
						build.copy,
						build.caseId,
						{ useWorktree: false, envProjectPath: run.project.path },
					);
				} catch (error) {
					appLog.warn("[BENCH] a build did not start:", error);
					buildEnded(build.taskId, "not-started", null);
				}
				await new Promise((resolve) => setTimeout(resolve, START_SPACING_MS));
			}
		} finally {
			run.pumping = false;
		}
	};

	agentManager.on("exit", (taskId: string, code: number | null) => {
		if (!isBenchBuild(taskId)) return;
		// The profile swap restarts a build in place: it runs again at once.
		setTimeout(() => {
			if (!agentManager.isRunning(taskId)) buildEnded(taskId, "ended", code);
		}, RESTART_GRACE_MS);
	});
	// A build that could not start says so with an error and no process.
	agentManager.on("error", (taskId: string) => {
		if (!isBenchBuild(taskId)) return;
		setTimeout(() => {
			if (!agentManager.isRunning(taskId)) buildEnded(taskId, "not-started", null);
		}, 1000);
	});
	// A rate limit or a lost sign-in says nothing about the model: the build
	// stops (and is not restarted later) and does not count.
	const interrupt = (taskId: string | undefined) => {
		if (!taskId || !isBenchBuild(taskId)) return;
		for (const run of active.values()) {
			if (run.running.has(taskId)) run.interrupted.add(taskId);
		}
		agentManager.haltTask(taskId);
	};
	agentManager.on("sdk-rate-limit", (info: { taskId?: string }) => interrupt(info?.taskId));
	agentManager.on("auth-failure", (taskId: string) => interrupt(taskId));

	const lookup = (projectId: unknown): Project | string => {
		if (typeof projectId !== "string" || !projectId) return "projectId is required";
		return projectStore.getProject(projectId) ?? "Project not found";
	};

	ipcMain.handle(
		IPC_CHANNELS.BENCH_CANDIDATES,
		async (_, projectId: unknown): Promise<IPCResult<BenchCandidate[]>> => {
			const project = lookup(projectId);
			if (typeof project === "string") return { success: false, error: project };
			const cards = finishedCards(project)
				.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
				.slice(0, MAX_CANDIDATES);
			if (cards.length === 0) return { success: true, data: [] };
			const result = await runRunner("discover", project, [
				"--specs",
				JSON.stringify(cards.map((t) => t.specId)),
			]);
			if (result.error) return { success: false, error: result.error };
			const cases = new Map(
				((result.data as { cases?: BenchCase[] })?.cases ?? []).map((c) => [c.caseId, c]),
			);
			return {
				success: true,
				data: cards.map((task) => ({
					specId: task.specId,
					title: task.title,
					case: cases.get(task.specId) ?? { caseId: task.specId, status: "refused" },
				})),
			};
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.BENCH_STATUS,
		async (_, projectId: unknown): Promise<IPCResult<BenchStatus>> => {
			const project = lookup(projectId);
			if (typeof project === "string") return { success: false, error: project };
			return { success: true, data: status(project) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.BENCH_START,
		async (
			_,
			projectId: unknown,
			rawSpecs: unknown,
			rawEngines: unknown,
			rawCommits: unknown,
		): Promise<IPCResult<BenchStatus>> => {
			const project = lookup(projectId);
			if (typeof project === "string") return { success: false, error: project };
			if (active.has(project.id)) {
				return { success: false, error: "A bench run is already going for this project" };
			}
			const specs = sanitizeSpecIds(rawSpecs, projectStore.getTasks(project.id));
			if (typeof specs === "string") return { success: false, error: specs };
			const engines = sanitizeEngines(rawEngines);
			if (typeof engines === "string") return { success: false, error: engines };
			const commits = sanitizeCommits(rawCommits, specs);
			if (typeof commits === "string") return { success: false, error: commits };

			const run: Active = {
				project,
				runId: newRunId(),
				busy: "preparing",
				queue: [],
				running: new Map(),
				interrupted: new Set(),
				pumping: false,
				discarding: false,
				chain: Promise.resolve(),
			};
			active.set(project.id, run);
			publish(project);
			// Calibration runs every case's tests three times: it is not awaited here.
			void serially(run, async () => {
				const prepared = await runRunner("prepare", project, [
					"--run-id",
					run.runId,
					"--specs",
					JSON.stringify(specs),
					"--engines",
					JSON.stringify(engines),
					...(Object.keys(commits).length ? ["--commits", JSON.stringify(commits)] : []),
				]);
				run.busy = undefined;
				const manifest = prepared.data as BenchManifest | undefined;
				if (prepared.error || !manifest) {
					run.error = prepared.error ?? "Preparation failed";
					finish(run);
					return;
				}
				if (run.discarding) return;
				run.queue = manifest.builds.filter((b) => b.state === "pending");
				if (run.queue.length === 0) {
					finish(run);
					return;
				}
				publish(project);
				void pump(run);
			});
			return { success: true, data: status(project) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.BENCH_DISCARD,
		async (_, projectId: unknown, runId: unknown): Promise<IPCResult<BenchStatus>> => {
			const project = lookup(projectId);
			if (typeof project === "string") return { success: false, error: project };
			if (typeof runId !== "string" || !RUN_ID.test(runId)) {
				return { success: false, error: "Invalid run id" };
			}
			const run = active.get(project.id);
			if (run && run.runId === runId) {
				run.discarding = true;
				run.busy = "discarding";
				run.queue = [];
				publish(project);
				for (const taskId of run.running.keys()) agentManager.haltTask(taskId);
				const deadline = Date.now() + DISCARD_WAIT_MS;
				while (run.running.size > 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				const result = await serially(run, () =>
					runRunner("discard", project, ["--run-id", runId]),
				);
				run.running.clear();
				if (active.get(project.id) === run) active.delete(project.id);
				publish(project);
				if (result.error) return { success: false, error: result.error };
				return { success: true, data: status(project) };
			}
			const result = await runRunner("discard", project, ["--run-id", runId]);
			publish(project);
			if (result.error) return { success: false, error: result.error };
			return { success: true, data: status(project) };
		},
	);
}
