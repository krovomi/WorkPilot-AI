/**
 * A multi-repo run against a fake app: the manifest on a real tmp dir, the
 * runner steps, projects and Kanban tasks faked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../shared/types";
import {
	createOrchestration,
	orchestrationDir,
	type RawManifest,
	readManifest,
	writeManifest,
} from "../manifest";
import {
	type MultiRepoHost,
	MultiRepoRun,
	parseRunnerEvents,
	repoTaskTitle,
	type RunnerEvent,
	type TaskSnapshot,
} from "../run";

let root: string;
let dir: string;

function hostProject(): Project {
	return {
		id: "host",
		name: "host",
		path: root,
		autoBuildPath: ".workpilot",
		settings: {} as Project["settings"],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

class FakeHost implements MultiRepoHost {
	readonly pollMs = 1_000_000;
	readonly steps: string[][] = [];
	readonly created: Array<{ projectId: string; title: string; description: string }> = [];
	readonly started: string[] = [];
	readonly stopped: string[] = [];
	readonly published: Array<{ status: string; running: boolean }> = [];
	readonly tasks = new Map<string, TaskSnapshot>();
	order = ["lib", "app"];
	analyzeOk = true;
	analyzeEvents: RunnerEvent[] = [];
	startOk = true;
	private listeners = new Set<
		(taskId: string, projectId: string | undefined, s: TaskSnapshot) => void
	>();

	async runStep(args: readonly string[]) {
		this.steps.push([...args]);
		if (args[0] === "analyze") {
			if (!this.analyzeOk) return { ok: false, events: this.analyzeEvents };
			const m = readManifest(dir) as RawManifest;
			m.execution_order = [...this.order];
			m.dependency_graph = {
				repos: [...this.order],
				dependencies: [
					{ source_repo: "app", target_repo: "lib", dependency_type: "package", details: "lib" },
				],
			};
			writeManifest(dir, m);
			return { ok: true, events: [{ event: "graph" }] };
		}
		if (args[0] === "brief") {
			const repo = args[args.indexOf("--repo") + 1];
			return { ok: true, events: [{ event: "brief", repo, description: `brief of ${repo}` }] };
		}
		return { ok: true, events: [{ event: "breaking_changes", changes: [] }] };
	}

	ensureProject(repoPath: string) {
		return { id: `p-${path.basename(repoPath)}` };
	}

	async createTask(projectId: string, title: string, description: string) {
		this.created.push({ projectId, title, description });
		const id = `00${this.created.length}-task`;
		this.tasks.set(id, { status: "backlog" });
		return id;
	}

	async startTask(taskId: string) {
		this.started.push(taskId);
		if (this.startOk) this.tasks.set(taskId, { status: "in_progress" });
		return this.startOk;
	}

	stopTask(taskId: string) {
		this.stopped.push(taskId);
	}

	taskSnapshot(_projectId: string, taskId: string) {
		return this.tasks.get(taskId) ?? null;
	}

	taskWorkspace(_projectId: string, taskId: string) {
		return {
			worktreePath: `/wt/${taskId}`,
			branchName: `workpilot/${taskId}`,
			baseBranch: "main",
			prUrl: "",
		};
	}

	onTaskStatus(listener: (taskId: string, projectId: string | undefined, s: TaskSnapshot) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publish(manifest: RawManifest, running: boolean) {
		this.published.push({ status: manifest.status, running });
	}

	/** The board moved task `taskId`. */
	move(taskId: string, snapshot: TaskSnapshot) {
		this.tasks.set(taskId, snapshot);
		for (const listener of [...this.listeners]) listener(taskId, undefined, snapshot);
	}
}

const PASSED: TaskSnapshot = { status: "human_review", reviewReason: "completed" };

function manifest(): RawManifest {
	return readManifest(dir) as RawManifest;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "multi-repo-run-"));
	const project = hostProject();
	const id = createOrchestration(
		project,
		[
			{ name: "app", path: "/repos/app", projectId: "p-app" },
			{ name: "lib", path: "/repos/lib", projectId: "p-lib" },
		],
		"Rename the client\n\nDetails here",
	);
	dir = orchestrationDir(project, id) as string;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("MultiRepoRun", () => {
	it("runs one card per repo, providers first, each after the previous passed QA", async () => {
		const host = new FakeHost();
		const run = new MultiRepoRun(dir, host);
		const done = run.run();

		await vi.waitFor(() => expect(host.started).toEqual(["001-task"]));
		expect(host.created[0]).toEqual({
			projectId: "p-lib",
			title: "lib: Rename the client",
			description: "brief of lib",
		});
		expect(manifest().status).toBe("executing");
		expect(manifest().repos.find((r) => r.repo === "lib")?.status).toBe("coding");

		host.move("001-task", { status: "ai_review" });
		expect(manifest().repos.find((r) => r.repo === "lib")?.status).toBe("qa");

		host.move("001-task", PASSED);
		await vi.waitFor(() => expect(host.started).toEqual(["001-task", "002-task"]));
		const lib = manifest().repos.find((r) => r.repo === "lib");
		expect(lib).toMatchObject({
			status: "completed",
			progress: 100,
			task_id: "001-task",
			worktree_path: "/wt/001-task",
			branch_name: "workpilot/001-task",
			base_branch: "main",
		});
		// The check ran after lib, before app's brief.
		expect(host.steps.map((s) => s[0])).toEqual(["analyze", "brief", "check", "brief"]);

		host.move("002-task", { status: "done" });
		await done;
		expect(manifest().status).toBe("completed");
		expect(run.running).toBe(false);
		expect(host.published.at(-1)).toEqual({ status: "completed", running: false });
	});

	it("waits on a card that needs a person, then goes on", async () => {
		const host = new FakeHost();
		const done = new MultiRepoRun(dir, host).run();
		await vi.waitFor(() => expect(host.started).toHaveLength(1));

		host.move("001-task", { status: "human_review", reviewReason: "qa_rejected" });
		expect(manifest()).toMatchObject({
			status: "executing",
			status_message: "status.waitingOnRepo",
			status_repo: "lib",
		});
		expect(host.created).toHaveLength(1);

		host.move("001-task", PASSED);
		await vi.waitFor(() => expect(host.created).toHaveLength(2));
		expect(manifest().status_message).toBe("");
		host.move("002-task", PASSED);
		await done;
		expect(manifest().status).toBe("completed");
	});

	it("stops the running card and stays resumable", async () => {
		const host = new FakeHost();
		const run = new MultiRepoRun(dir, host);
		const done = run.run();
		await vi.waitFor(() => expect(host.started).toHaveLength(1));

		run.stop();
		await done;
		expect(host.stopped).toEqual(["001-task"]);
		expect(manifest().status).toBe("stopped");
		expect(host.created).toHaveLength(1);
		expect(host.published.at(-1)?.running).toBe(false);
	});

	it("resumes where it was: done repos skipped, existing cards reused", async () => {
		const m = manifest();
		m.execution_order = ["lib", "app"];
		Object.assign(m.repos.find((r) => r.repo === "lib") as object, {
			status: "completed",
			task_id: "001-task",
			project_id: "p-lib",
		});
		Object.assign(m.repos.find((r) => r.repo === "app") as object, {
			status: "pending",
			task_id: "002-task",
			project_id: "p-app",
		});
		m.status = "stopped";
		writeManifest(dir, m);

		const host = new FakeHost();
		host.tasks.set("002-task", { status: "human_review", reviewReason: "stopped" });
		const done = new MultiRepoRun(dir, host).run();
		await vi.waitFor(() => expect(host.started).toEqual(["002-task"]));
		expect(host.created).toEqual([]);

		host.move("002-task", PASSED);
		await done;
		expect(manifest().status).toBe("completed");
	});

	it("fails on a dependency cycle, before any card", async () => {
		const host = new FakeHost();
		host.analyzeOk = false;
		host.analyzeEvents = [{ event: "error", code: "cycle" }];
		await new MultiRepoRun(dir, host).run();
		expect(manifest()).toMatchObject({
			status: "failed",
			status_message: "errors.circularDependency",
		});
		expect(host.created).toEqual([]);
	});

	it("fails on a card that cannot start, naming the repo", async () => {
		const host = new FakeHost();
		host.startOk = false;
		await new MultiRepoRun(dir, host).run();
		expect(manifest()).toMatchObject({
			status: "failed",
			status_message: "errors.taskStartFailed",
			status_repo: "lib",
		});
	});

	it("fails when the card it waits on is deleted", async () => {
		const host = new FakeHost();
		const done = new MultiRepoRun(dir, host).run();
		await vi.waitFor(() => expect(host.started).toHaveLength(1));
		host.tasks.delete("001-task");
		// What the board answers for a card that is gone.
		host.move("001-task", null as unknown as TaskSnapshot);
		await done;
		expect(manifest()).toMatchObject({
			status: "failed",
			status_message: "errors.taskMissing",
			status_repo: "lib",
		});
	});
});

describe("repoTaskTitle", () => {
	it("names the repo, then the first line of the change, bounded", () => {
		expect(repoTaskTitle("api", "\n  Add auth \nmore")).toBe("api: Add auth");
		const long = repoTaskTitle("api", "x".repeat(300));
		expect(long).toHaveLength(120);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("parseRunnerEvents", () => {
	it("keeps the prefixed JSON lines that carry an event", () => {
		const out = [
			"noise",
			'[MULTI_REPO] {"event": "graph", "execution_order": ["a"]}',
			"[MULTI_REPO] not json",
			'[MULTI_REPO] {"no_event": 1}',
			'[MULTI_REPO] {"event": "brief", "description": "d"}\r',
		].join("\n");
		expect(parseRunnerEvents(out).map((e) => e.event)).toEqual(["graph", "brief"]);
	});
});
