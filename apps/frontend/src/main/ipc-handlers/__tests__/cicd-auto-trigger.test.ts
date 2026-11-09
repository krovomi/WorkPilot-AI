/**
 * @vitest-environment node
 *
 * CI/CD Triggers after an agent's pull request (#378): the pipeline starts on
 * its own only when the project's settings ask for it, the run is recorded as
 * automatic with its task, and a pipeline that cannot start is reported, never
 * thrown at the pull request.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	spawned: [] as string[][],
	answer: { code: 0, stdout: "", stderr: "" } as { code: number; stdout: string; stderr: string },
	spawnThrows: false,
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import("../../../__tests__/helpers/fake-safe-storage");
	return {
		app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: { handle: () => undefined },
	};
});

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: (_cmd: string, args: string[]) => {
		state.spawned.push(args);
		const proc = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
		};
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		setTimeout(() => {
			if (state.spawnThrows) {
				proc.emit("error", new Error("python missing"));
				return;
			}
			if (state.answer.stdout) proc.stdout.emit("data", Buffer.from(state.answer.stdout));
			if (state.answer.stderr) proc.stderr.emit("data", Buffer.from(state.answer.stderr));
			proc.emit("close", state.answer.code);
		}, 0);
		return proc;
	},
}));

vi.mock("../../project-store", () => ({ projectStore: { getProjects: () => [] } }));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));

import { autoTriggerForTask, autoTriggerProvider } from "../cicd-triggers-handlers";

const PR = {
	prUrl: "https://github.com/acme/shop/pull/7",
	branch: "workpilot/012-cart",
	taskId: "t-12",
	specId: "012-cart",
};

describe("autoTriggerProvider", () => {
	it.each([
		[{}, "pr", null],
		[{ CICD_AUTO_TRIGGER: "false", CICD_PROVIDER: "github" }, "pr", null],
		[{ CICD_AUTO_TRIGGER: "true" }, "pr", null],
		[{ CICD_AUTO_TRIGGER: "true", CICD_PROVIDER: "circleci" }, "pr", null],
		[{ CICD_AUTO_TRIGGER: "true", CICD_PROVIDER: "github" }, "pr", "github"],
		[{ CICD_AUTO_TRIGGER: "true", CICD_PROVIDER: "gitlab" }, "merge", "gitlab"],
		[{ CICD_AUTO_TRIGGER: "true", CICD_PROVIDER: "azure", CICD_TRIGGER_ON_PR: "false" }, "pr", null],
		[{ CICD_AUTO_TRIGGER: "true", CICD_PROVIDER: "azure", CICD_TRIGGER_ON_PR: "false" }, "merge", "azure"],
		[{ CICD_AUTO_TRIGGER: "true", CICD_PROVIDER: "jenkins", CICD_TRIGGER_ON_MERGE: "false" }, "merge", null],
	] as const)("%j on %s → %s", (config, event, expected) => {
		expect(autoTriggerProvider(config as Record<string, string>, event)).toBe(expected);
	});
});

describe("autoTriggerForTask", () => {
	let projectDir: string;

	function project() {
		return {
			id: "p1",
			name: "shop",
			path: projectDir,
			autoBuildPath: ".workpilot",
			settings: {},
			createdAt: new Date(),
			updatedAt: new Date(),
		} as unknown as Parameters<typeof autoTriggerForTask>[0];
	}

	function configure(lines: string[]) {
		mkdirSync(path.join(projectDir, ".workpilot"), { recursive: true });
		writeFileSync(path.join(projectDir, ".workpilot", ".env"), `${lines.join("\n")}\n`, "utf-8");
	}

	function runs(): Array<Record<string, unknown>> {
		return JSON.parse(
			readFileSync(path.join(projectDir, ".workpilot", "cicd_runs.json"), "utf-8"),
		);
	}

	beforeEach(() => {
		projectDir = mkdtempSync(path.join(tmpdir(), "cicd-auto-"));
		state.spawned = [];
		state.answer = { code: 0, stdout: "", stderr: "" };
		state.spawnThrows = false;
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("does nothing when the settings do not ask for it", async () => {
		configure(["CICD_PROVIDER=github", "CICD_AUTO_TRIGGER=false"]);
		expect(await autoTriggerForTask(project(), "pr", PR)).toBeNull();
		expect(state.spawned).toEqual([]);
	});

	it("does nothing for a project never configured", async () => {
		expect(await autoTriggerForTask(project(), "pr", PR)).toBeNull();
		expect(state.spawned).toEqual([]);
	});

	it("starts the pipeline of the PR and records an automatic run for the task", async () => {
		configure(["CICD_PROVIDER=github", "CICD_AUTO_TRIGGER=true"]);
		state.answer.stdout = JSON.stringify({ provider: "github", status: "triggered" });

		const run = await autoTriggerForTask(project(), "pr", PR);

		expect(run).toMatchObject({ provider: "github", event: "pr", status: "triggered" });
		expect(run?.error).toBeUndefined();
		const args = state.spawned[0];
		expect(args.slice(args.indexOf("--action"), args.indexOf("--action") + 4)).toEqual([
			"--action",
			"trigger",
			"--provider",
			"github",
		]);
		expect(args[args.indexOf("--pr-url") + 1]).toBe(PR.prUrl);
		expect(args[args.indexOf("--branch") + 1]).toBe(PR.branch);
		expect(runs()[0]).toMatchObject({
			id: run?.id,
			status: "triggered",
			source: "auto",
			event: "pr",
			task_id: "t-12",
			spec_id: "012-cart",
		});
	});

	it("reports a pipeline the provider refused, with its reason", async () => {
		configure(["CICD_PROVIDER=gitlab", "CICD_AUTO_TRIGGER=true"]);
		state.answer.stdout = JSON.stringify({ provider: "gitlab", error: "CICD_GITLAB_TOKEN not configured" });

		const run = await autoTriggerForTask(project(), "merge", { ...PR, branch: "main" });

		expect(run).toMatchObject({
			provider: "gitlab",
			event: "merge",
			status: "failed",
			error: "CICD_GITLAB_TOKEN not configured",
		});
	});

	it("reports a runner that failed or could not start, without throwing", async () => {
		configure(["CICD_PROVIDER=jenkins", "CICD_AUTO_TRIGGER=true"]);
		state.answer = { code: 1, stdout: "", stderr: "Traceback: boom" };
		expect(await autoTriggerForTask(project(), "pr", PR)).toMatchObject({
			status: "failed",
			error: "Traceback: boom",
		});
		expect(runs()[0]).toMatchObject({ status: "failed", source: "auto" });

		state.spawnThrows = true;
		expect(await autoTriggerForTask(project(), "pr", PR)).toMatchObject({
			status: "failed",
			error: "python missing",
		});
	});

	it("keeps only an https pipeline link", async () => {
		configure(["CICD_PROVIDER=gitlab", "CICD_AUTO_TRIGGER=true"]);
		state.answer.stdout = JSON.stringify({ status: "triggered", web_url: "javascript:alert(1)" });
		expect((await autoTriggerForTask(project(), "pr", PR))?.webUrl).toBeUndefined();
		state.answer.stdout = JSON.stringify({ status: "triggered", web_url: "https://gitlab.com/acme/shop/-/pipelines/9" });
		expect((await autoTriggerForTask(project(), "pr", PR))?.webUrl).toBe(
			"https://gitlab.com/acme/shop/-/pipelines/9",
		);
	});
});
