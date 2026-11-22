/**
 * @vitest-environment node
 *
 * The linked services, the figures and the verdict reviews of the CI/CD page
 * (#366, lot 4): each argument from the renderer is checked, the links live
 * in the app's user data folder, and a rollback takes the linked projects
 * back, each with its own CI/CD settings.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const state = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
	projects: [] as Array<{ id: string; name: string; path: string; autoBuildPath: string }>,
	spawned: [] as Array<{ args: string[]; cwd: string; env: Record<string, string> }>,
	answers: [] as Array<{ code: number; stdout?: string; write?: () => void }>,
	userData: "",
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import("../../../__tests__/helpers/fake-safe-storage");
	return {
		app: {
			getPath: () => state.userData,
			getAppPath: () => state.userData,
			isPackaged: false,
		},
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler),
		},
	};
});

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: (_cmd: string, args: string[], options: { env: Record<string, string>; cwd: string }) => {
		state.spawned.push({ args, cwd: options.cwd, env: options.env });
		const answer = state.answers.shift() ?? { code: 0, stdout: "{}" };
		const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		setTimeout(() => {
			answer.write?.();
			if (answer.stdout) proc.stdout.emit("data", Buffer.from(answer.stdout));
			proc.emit("close", answer.code);
		}, 0);
		return proc;
	},
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProjects: () => state.projects },
}));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));
vi.mock("../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async (_backend: string, options: { extra?: Record<string, string> }) => ({
		...options.extra,
	}),
}));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "en" }));
vi.mock("../../notification-service", () => ({ notificationService: { announce: () => undefined } }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerCICDTriggersHandlers } from "../cicd-triggers-handlers";

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return Promise.resolve(handler({}, ...args));
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const RUN = "1763200000000";

function plan(targetAt = "2026-11-15T08:00:00+00:00") {
	return { provider: "github", reason: "rerun", automatic: true, target_run: "10", target_at: targetAt };
}

describe("CI/CD linked services, figures and reviews", () => {
	let root: string;
	let api: string;
	let web: string;

	function configure(dir: string, lines: string[]) {
		mkdirSync(path.join(dir, ".workpilot"), { recursive: true });
		writeFileSync(path.join(dir, ".workpilot", ".env"), `${lines.join("\n")}\n`, "utf-8");
	}

	function writeWatch(dir: string, runId: string, content: object) {
		const watches = path.join(dir, ".workpilot", "deploy_watches");
		mkdirSync(watches, { recursive: true });
		writeFileSync(path.join(watches, `${runId}.json`), JSON.stringify(content), "utf-8");
	}

	function writeRuns(dir: string, runs: object[]) {
		mkdirSync(path.join(dir, ".workpilot"), { recursive: true });
		writeFileSync(path.join(dir, ".workpilot", "cicd_runs.json"), JSON.stringify(runs), "utf-8");
	}

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "cicd-links-"));
		state.userData = path.join(root, "user-data");
		api = path.join(root, "api");
		web = path.join(root, "web");
		mkdirSync(api);
		mkdirSync(web);
		state.projects = [
			{ id: "p-api", name: "Shop API", path: api, autoBuildPath: ".workpilot" },
			{ id: "p-web", name: "Shop web", path: web, autoBuildPath: ".workpilot" },
			{ id: "p-docs", name: "Docs", path: path.join(root, "docs"), autoBuildPath: ".workpilot" },
		];
		state.spawned = [];
		state.answers = [];
		state.handlers.clear();
		registerCICDTriggersHandlers();
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("links known projects only, stored with the app, never in the repository", async () => {
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_GET_LINKS, path.join(root, "nope"))).toMatchObject({
			success: false,
		});
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, path.join(root, "nope"), [])).toMatchObject({
			success: false,
		});
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, api, ["../p-web"])).toEqual({
			success: false,
			error: "invalid-links",
		});
		const saved = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, api, ["p-web", "p-api", "p-gone"])) as {
			data: { linked: Array<{ id: string }>; candidates: Array<{ id: string }> };
		};
		expect(saved.data.linked.map((p) => p.id)).toEqual(["p-web"]);
		expect(saved.data.candidates.map((p) => p.id)).toEqual(["p-docs"]);
		expect(JSON.parse(readFileSync(path.join(state.userData, "deploy-links.json"), "utf-8")).links).toEqual({
			"p-api": ["p-web"],
		});
		expect(existsSync(path.join(api, ".workpilot", "deploy-links.json"))).toBe(false);
		const view = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_GET_LINKS, web)) as {
			data: { linked: unknown[]; candidates: Array<{ id: string }> };
		};
		expect(view.data.linked).toEqual([]);
		expect(view.data.candidates.map((p) => p.id)).toEqual(["p-api", "p-docs"]);
	});

	it("reports a links file it cannot write", async () => {
		writeFileSync(state.userData, "a file where the folder should be", "utf-8");
		const result = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, api, ["p-web"])) as { success: boolean };
		expect(result.success).toBe(false);
	});

	it("rolls the linked project back with its own settings after a person's rollback", async () => {
		configure(api, ["CICD_PROVIDER=github", "CICD_GITHUB_TOKEN=gh-api-0000"]);
		configure(web, ["CICD_PROVIDER=gitlab", "CICD_GITLAB_TOKEN=gl-web-0000"]);
		writeRuns(api, [{ id: RUN, provider: "github", triggered_at: "2026-11-15T10:00:00Z" }]);
		writeWatch(api, RUN, { run_id: RUN, phase: "done", verdict: "critical", rollback: "proposed", plan: plan() });
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, api, ["p-web"]);
		state.answers = [
			{
				code: 0,
				stdout: "{}",
				write: () =>
					writeWatch(api, RUN, {
						run_id: RUN,
						phase: "done",
						verdict: "critical",
						rollback: "started",
						rollback_by: "person",
						plan: plan(),
					}),
			},
			{ code: 0, stdout: JSON.stringify({ status: "manual", run_id: "1763100000000" }) },
		];
		const result = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, api, RUN)) as { success: boolean };
		expect(result.success).toBe(true);
		expect(state.spawned).toHaveLength(2);
		const linked = state.spawned[1];
		expect(linked.cwd).toBe(web);
		expect(linked.args.slice(-8)).toEqual([
			"--action",
			"rollback-linked",
			"--project",
			web,
			"--since",
			"2026-11-15T08:00:00+00:00",
			"--cause",
			"Shop API",
		]);
		// The linked project's own token, never the root's.
		expect(linked.env.CICD_GITLAB_TOKEN).toBe("gl-web-0000");
		expect(linked.env.CICD_GITHUB_TOKEN).toBeUndefined();

		const runs = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_LIST_RUNS, api)) as {
			data: Array<{ watch?: { linked?: Array<{ projectId: string; status: string }> } }>;
		};
		expect(runs.data[0].watch?.linked).toEqual([
			expect.objectContaining({ projectId: "p-web", name: "Shop web", status: "manual" }),
		]);
	});

	it("takes nothing back when the rollback did not start or nothing is linked", async () => {
		configure(api, ["CICD_PROVIDER=github"]);
		writeRuns(api, [{ id: RUN, provider: "github", triggered_at: "2026-11-15T10:00:00Z" }]);
		writeWatch(api, RUN, { run_id: RUN, phase: "done", verdict: "critical", rollback: "failed", plan: plan() });
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, api, ["p-web"]);
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, api, RUN);
		expect(state.spawned).toHaveLength(1);
		// Started, but the plan does not say where it went back to.
		writeWatch(api, RUN, { run_id: RUN, phase: "done", verdict: "critical", rollback: "started", plan: plan("") });
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, api, RUN);
		expect(state.spawned).toHaveLength(2);
		// A feature flag turned off redeployed nothing: the linked services stay.
		writeWatch(api, RUN, {
			run_id: RUN,
			phase: "done",
			verdict: "critical",
			rollback: "started",
			strategy: "flag",
			plan: plan(),
		});
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, api, RUN);
		expect(state.spawned).toHaveLength(3);
	});

	it("rolls the linked projects back after an automatic rollback", async () => {
		configure(api, ["CICD_PROVIDER=github", "CICD_MONITOR_HEALTH_URL=https://app.example/health"]);
		configure(web, ["CICD_PROVIDER=github"]);
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, api, ["p-web"]);
		let runId = "";
		state.answers = [
			{ code: 0, stdout: '{"status":"triggered"}' },
			{
				code: 0,
				stdout: "{}",
				write: () => {
					const args = state.spawned[1].args;
					runId = args[args.indexOf("--run-id") + 1];
					writeWatch(api, runId, {
						run_id: runId,
						phase: "done",
						verdict: "critical",
						rollback: "started",
						plan: plan(),
					});
				},
			},
			{ code: 1, stdout: "" },
		];
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, api, { provider: "github" });
		await tick();
		await tick();
		await tick();
		expect(state.spawned).toHaveLength(3);
		expect(state.spawned[2].args).toContain("rollback-linked");
		const runs = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_LIST_RUNS, api)) as {
			data: Array<{ watch?: { linked?: Array<{ status: string }> } }>;
		};
		expect(runs.data[0].watch?.linked?.map((l) => l.status)).toEqual(["error"]);
	});

	it("records a person's word on a bad verdict, and counts it in the figures", async () => {
		writeWatch(api, RUN, {
			run_id: RUN,
			phase: "done",
			verdict: "critical",
			started_at: new Date().toISOString(),
			rollback: "started",
		});
		writeWatch(api, "7", { run_id: "7", phase: "done", verdict: "ok" });
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, path.join(root, "x"), RUN, null)).toMatchObject({
			success: false,
		});
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, api, "../x", null)).toEqual({
			success: false,
			error: "Invalid run id",
		});
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, api, RUN, "whatever")).toEqual({
			success: false,
			error: "invalid-review",
		});
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, api, "7", "false_positive")).toEqual({
			success: false,
			error: "no-bad-verdict",
		});
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, api, "8", "confirmed")).toEqual({
			success: false,
			error: "no-bad-verdict",
		});
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, api, RUN, "false_positive")).toEqual({
			success: true,
		});
		const figures = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_GET_FIGURES, api)) as {
			data: { falsePositiveRollbacks: number; incidentsAvoided: number; watches: number };
		};
		expect(figures.data).toMatchObject({ watches: 2, falsePositiveRollbacks: 1, incidentsAvoided: 0 });
		writeRuns(api, [{ id: RUN }]);
		const runs = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_LIST_RUNS, api)) as {
			data: Array<{ watch?: { review?: string } }>;
		};
		expect(runs.data[0].watch?.review).toBe("false_positive");
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_GET_FIGURES, path.join(root, "x"))).toMatchObject({
			success: false,
		});
	});

	it("reports a review it cannot write", async () => {
		writeWatch(api, RUN, { run_id: RUN, phase: "done", verdict: "warning" });
		mkdirSync(path.join(api, ".workpilot", "deploy_watches", "reviews.json"));
		const result = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, api, RUN, "confirmed")) as {
			success: boolean;
		};
		expect(result.success).toBe(false);
	});
});
