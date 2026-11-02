/**
 * One run of a multi-repo orchestration.
 *
 * 1. `analyze` (Python): dependency graph and execution order, providers first.
 * 2. For each repo in that order: a Kanban task of the repo's own project,
 *    described by `brief` (Python) with what the repos done before it
 *    changed, started like any task, and followed until it passes QA.
 *    A task that needs a person (plan to approve, QA rejection, error) holds
 *    the run there; it goes on when the task moves again on the board.
 * 3. After each repo: `check` (Python) records the breaking changes its diff
 *    makes for the repos that depend on it; their briefs carry them.
 *
 * The manifest is the run's state: a stopped run (or one the app was closed
 * on) starts again where it was, reusing the tasks it already created.
 *
 * Everything outside the manifest goes through `MultiRepoHost`, so the run is
 * tested with fakes (`__tests__/run.test.ts`) and wired to the app in
 * `host.ts`.
 */
import type { ReviewReason, TaskStatus } from "../../shared/types";
import { type RawManifest, type RawRepo, readManifest, writeManifest } from "./manifest";
import { progressOf, repoStatusFromTask, waitsForSomeone } from "./task-outcome";

export interface RunnerEvent {
	readonly event: string;
	readonly [key: string]: unknown;
}

export interface TaskSnapshot {
	readonly status: TaskStatus;
	readonly reviewReason?: ReviewReason;
}

export interface TaskWorkspace {
	readonly worktreePath: string;
	readonly branchName: string;
	readonly baseBranch: string;
	readonly prUrl: string;
}

export interface MultiRepoHost {
	/** One step of `runners/multi_repo_runner.py`; killed when `signal` aborts. */
	runStep(
		args: readonly string[],
		signal: AbortSignal,
	): Promise<{ ok: boolean; events: RunnerEvent[] }>;
	/** The registered, initialized project of a repo path, added if needed. */
	ensureProject(repoPath: string): { id: string } | null;
	createTask(projectId: string, title: string, description: string): Promise<string | null>;
	/** `false` when the task could not start (missing sign-in, bad project…). */
	startTask(taskId: string): Promise<boolean>;
	/** Stops the task if its agents are running; nothing otherwise. */
	stopTask(taskId: string): void;
	/** The task as the board shows it; `null` when it no longer exists. */
	taskSnapshot(projectId: string, taskId: string): TaskSnapshot | null;
	taskWorkspace(projectId: string, taskId: string): TaskWorkspace;
	/** Live status changes of every task; answers the unsubscribe. */
	onTaskStatus(
		listener: (taskId: string, projectId: string | undefined, snapshot: TaskSnapshot) => void,
	): () => void;
	/** Tells the renderer what the orchestration now is. */
	publish(manifest: RawManifest, running: boolean): void;
	/** How often a waiting run re-reads its task from disk (safety net). */
	readonly pollMs?: number;
}

const EVENT_PREFIX = "[MULTI_REPO] ";

/** The `[MULTI_REPO]` lines of a runner's output. */
export function parseRunnerEvents(stdout: string): RunnerEvent[] {
	const events: RunnerEvent[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith(EVENT_PREFIX)) continue;
		try {
			const parsed: unknown = JSON.parse(line.slice(EVENT_PREFIX.length));
			if (parsed && typeof parsed === "object" && typeof (parsed as RunnerEvent).event === "string") {
				events.push(parsed as RunnerEvent);
			}
		} catch {
			// A line that is not JSON is not an event.
		}
	}
	return events;
}

type RepoOutcome = "completed" | "stopped" | "failed";
type WaitOutcome = "completed" | "stopped" | "missing";

const TITLE_MAX = 120;

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/** The title of a repo's card: which repo, then which change. */
export function repoTaskTitle(repo: string, taskDescription: string): string {
	const title = `${repo}: ${firstLine(taskDescription)}`;
	return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

export class MultiRepoRun {
	private readonly abort = new AbortController();
	private active = false;
	private waitingTask: { projectId: string; taskId: string } | null = null;

	constructor(
		private readonly dir: string,
		private readonly host: MultiRepoHost,
	) {}

	get running(): boolean {
		return this.active;
	}

	/** The whole run; resolves once completed, failed or stopped. */
	async run(): Promise<void> {
		this.active = true;
		try {
			await this.execute();
		} catch (error) {
			console.error("[MultiRepo] Run failed:", error);
			this.fail("errors.unexpected");
		} finally {
			this.active = false;
			const m = readManifest(this.dir);
			if (m) this.host.publish(m, false);
		}
	}

	/** Stops the run and the repo task it is running; the run can start again. */
	stop(): void {
		if (this.abort.signal.aborted) return;
		// Read before aborting: the abort ends the wait, which forgets the task.
		const waiting = this.waitingTask;
		this.abort.abort();
		if (waiting) this.host.stopTask(waiting.taskId);
		const m = readManifest(this.dir);
		if (!m) return;
		m.status = "stopped";
		m.status_message = "";
		m.status_repo = "";
		writeManifest(this.dir, m);
		this.host.publish(m, false);
	}

	private get stopped(): boolean {
		return this.abort.signal.aborted;
	}

	/** Writes and publishes `m` unless the run was stopped meanwhile. */
	private save(m: RawManifest): void {
		if (this.stopped) return;
		writeManifest(this.dir, m);
		this.host.publish(m, true);
	}

	private fail(key: string, repo = ""): void {
		if (this.stopped) return;
		const m = readManifest(this.dir);
		if (!m) return;
		m.status = "failed";
		m.status_message = key;
		m.status_repo = repo;
		writeManifest(this.dir, m);
		this.host.publish(m, false);
	}

	private async execute(): Promise<void> {
		const start = readManifest(this.dir);
		if (!start) return;
		start.status = "analyzing";
		start.status_message = "";
		start.status_repo = "";
		this.save(start);

		const analysis = await this.host.runStep(
			[
				"analyze",
				"--spec-dir",
				this.dir,
				"--task",
				start.task_description,
				"--repos",
				start.repos.map((r) => `${r.repo}::${r.repo_path}`).join(","),
			],
			this.abort.signal,
		);
		if (this.stopped) return;
		if (!analysis.ok) {
			const cycle = analysis.events.some((e) => e.event === "error" && e.code === "cycle");
			this.fail(cycle ? "errors.circularDependency" : "errors.analysisFailed");
			return;
		}

		const analyzed = readManifest(this.dir);
		if (!analyzed) return;
		analyzed.status = "executing";
		this.save(analyzed);

		for (const repo of analyzed.execution_order) {
			const outcome = await this.runRepo(repo);
			if (outcome !== "completed") return;
		}

		const done = readManifest(this.dir);
		if (!done || this.stopped) return;
		done.status = "completed";
		done.status_message = "";
		done.status_repo = "";
		this.save(done);
	}

	private repoOf(m: RawManifest, repo: string): RawRepo | undefined {
		return m.repos.find((r) => r.repo === repo);
	}

	private async runRepo(repo: string): Promise<RepoOutcome> {
		const m = readManifest(this.dir);
		const sub = m ? this.repoOf(m, repo) : undefined;
		if (!m || !sub) {
			this.fail("errors.unexpected", repo);
			return "failed";
		}
		if (sub.status === "completed" && sub.task_id) return "completed";

		if (!sub.task_id) {
			const created = await this.createRepoTask(m, sub);
			if (created !== "started") return created;
		} else {
			const snapshot = this.host.taskSnapshot(sub.project_id, sub.task_id);
			if (!snapshot) {
				this.fail("errors.taskMissing", repo);
				return "failed";
			}
			// Created by an earlier run and never started, or stopped since.
			if (
				repoStatusFromTask(snapshot.status, snapshot.reviewReason) === "pending" &&
				!(await this.host.startTask(sub.task_id))
			) {
				this.fail("errors.taskStartFailed", repo);
				return "failed";
			}
		}

		const waited = await this.waitForTask(repo);
		if (waited === "stopped") return "stopped";
		if (waited === "missing") {
			this.fail("errors.taskMissing", repo);
			return "failed";
		}

		const after = readManifest(this.dir);
		const finished = after ? this.repoOf(after, repo) : undefined;
		if (!after || !finished) return "failed";
		const workspace = this.host.taskWorkspace(finished.project_id, finished.task_id);
		finished.worktree_path = workspace.worktreePath;
		finished.branch_name = workspace.branchName;
		finished.base_branch = workspace.baseBranch;
		finished.pr_url = workspace.prUrl;
		finished.status = "completed";
		finished.progress = 100;
		after.status_message = "";
		after.status_repo = "";
		this.save(after);

		const check = await this.host.runStep(
			["check", "--spec-dir", this.dir],
			this.abort.signal,
		);
		if (this.stopped) return "stopped";
		if (!check.ok) console.warn(`[MultiRepo] Breaking-change check failed after ${repo}`);
		const checked = readManifest(this.dir);
		if (checked) this.host.publish(checked, true);
		return "completed";
	}

	/** Brief, card and start of `sub`'s task. */
	private async createRepoTask(
		m: RawManifest,
		sub: RawRepo,
	): Promise<"started" | "stopped" | "failed"> {
		const project = this.host.ensureProject(sub.repo_path);
		if (!project) {
			this.fail("errors.projectUnavailable", sub.repo);
			return "failed";
		}
		const brief = await this.host.runStep(
			["brief", "--spec-dir", this.dir, "--repo", sub.repo],
			this.abort.signal,
		);
		if (this.stopped) return "stopped";
		const description = brief.events.find((e) => e.event === "brief")?.description;
		if (!brief.ok || typeof description !== "string" || !description.trim()) {
			this.fail("errors.briefFailed", sub.repo);
			return "failed";
		}

		const taskId = await this.host.createTask(
			project.id,
			repoTaskTitle(sub.repo, m.task_description),
			description,
		);
		if (this.stopped) return "stopped";
		if (!taskId) {
			this.fail("errors.taskCreateFailed", sub.repo);
			return "failed";
		}

		const fresh = readManifest(this.dir);
		const target = fresh ? this.repoOf(fresh, sub.repo) : undefined;
		if (!fresh || !target) return "failed";
		target.project_id = project.id;
		target.task_id = taskId;
		target.status = "pending";
		target.progress = 0;
		this.save(fresh);
		if (!(await this.host.startTask(taskId))) {
			this.fail("errors.taskStartFailed", sub.repo);
			return "failed";
		}
		return "started";
	}

	/** Follows `repo`'s task until it passed QA, disappears or the run stops. */
	private waitForTask(repo: string): Promise<WaitOutcome> {
		const start = readManifest(this.dir);
		const sub = start ? this.repoOf(start, repo) : undefined;
		if (!sub) return Promise.resolve("missing");
		const { project_id: projectId, task_id: taskId } = sub;
		this.waitingTask = { projectId, taskId };

		return new Promise<WaitOutcome>((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | null = null;
			let timer: ReturnType<typeof setInterval> | undefined;
			const onAbort = () => finish("stopped");
			const finish = (outcome: WaitOutcome) => {
				if (settled) return;
				settled = true;
				if (timer) clearInterval(timer);
				unsubscribe?.();
				this.abort.signal.removeEventListener("abort", onAbort);
				this.waitingTask = null;
				resolve(outcome);
			};
			const apply = (snapshot: TaskSnapshot | null) => {
				if (settled) return;
				if (!snapshot) {
					finish("missing");
					return;
				}
				const status = repoStatusFromTask(snapshot.status, snapshot.reviewReason);
				if (status === "completed") {
					finish("completed");
					return;
				}
				this.recordRepoStatus(repo, status);
			};

			if (this.stopped) {
				finish("stopped");
				return;
			}
			this.abort.signal.addEventListener("abort", onAbort, { once: true });
			unsubscribe = this.host.onTaskStatus((id, project, snapshot) => {
				if (id === taskId && (project === undefined || project === projectId)) {
					apply(snapshot);
				}
			});
			timer = setInterval(
				() => apply(this.host.taskSnapshot(projectId, taskId)),
				this.host.pollMs ?? 15_000,
			);
			apply(this.host.taskSnapshot(projectId, taskId));
		});
	}

	private recordRepoStatus(repo: string, status: RawRepo["status"]): void {
		const m = readManifest(this.dir);
		const sub = m ? this.repoOf(m, repo) : undefined;
		if (!m || !sub) return;
		const waiting = waitsForSomeone(status);
		const message = waiting ? "status.waitingOnRepo" : "";
		if (sub.status === status && m.status_message === message) return;
		sub.status = status;
		sub.progress = progressOf(status, sub.progress);
		m.status_message = message;
		m.status_repo = waiting ? repo : "";
		this.save(m);
	}
}
