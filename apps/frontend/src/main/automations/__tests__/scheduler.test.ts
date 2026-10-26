/**
 * The scheduler joins a pass already running instead of doubling it, tells
 * the window when cards appeared or a source failed, and leaves alone a
 * project with no enabled rule.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { AutomationRule, Project } from "../../../shared/types";

const state = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProjects: () => state.projects,
		getTasks: () => [],
		invalidateTasksCache: vi.fn(),
	},
}));
vi.mock("../../ci-pipeline-service", () => ({ readMergedProjectEnv: () => ({}) }));
vi.mock("../../ci-pipeline-providers", () => ({ resolvePipelineProvider: async () => null }));
vi.mock("../../ipc-handlers/github/utils", () => ({
	getGitHubConfig: () => null,
	githubFetch: vi.fn(),
	normalizeRepoReference: (r: string) => r,
}));
vi.mock("../../app-logger", () => ({ appLog: { warn: vi.fn() } }));

import { parseRule } from "../rules";
import type { RunDeps } from "../run";
import { AutomationScheduler, liveDeps } from "../scheduler";
import { readLedger, writeRules } from "../store";

let root: string;
let project: Project;
const sent: unknown[][] = [];
const window = { webContents: { send: (...args: unknown[]) => sent.push(args) } };

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "automations-sched-"));
	project = { id: "p1", name: "p", path: root, autoBuildPath: ".workpilot", settings: {} } as unknown as Project;
	state.projects = [project];
	sent.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function schedule(enabled = true) {
	const rule = parseRule(
		{ name: "Daily", enabled, trigger: { type: "schedule", time: "00:00", days: [0, 1, 2, 3, 4, 5, 6], title: "Daily check", prompt: "Look" } },
		undefined,
		new Date(2000, 0, 1),
	) as AutomationRule;
	writeRules(project, [rule]);
}

describe("AutomationScheduler", () => {
	it("joins a pass already running and announces the card", async () => {
		schedule();
		const deps = liveDeps({ startSpecCreation: vi.fn() } as never);
		const readSource = vi.spyOn(deps, "readSource");
		const scheduler = new AutomationScheduler(deps, () => window as never);
		const [a, b] = await Promise.all([scheduler.run(project), scheduler.run(project)]);
		expect(a).toEqual({ created: 1, errors: 0 });
		expect(b).toBe(a);
		expect(readSource).toHaveBeenCalledTimes(1);
		expect(sent).toEqual([[IPC_CHANNELS.AUTOMATIONS_EVENT, { projectId: "p1", created: 1 }]]);
	});

	it("names the missing connector instead of finding nothing", async () => {
		const rule = parseRule({ name: "Issues", trigger: { type: "issue_labeled", label: "wp" } }) as AutomationRule;
		writeRules(project, [rule]);
		const scheduler = new AutomationScheduler(liveDeps({} as never), () => window as never);
		expect(await scheduler.run(project)).toEqual({ created: 0, errors: 1 });
		expect(readLedger(project).statuses[rule.id].lastError).toBe("github_not_connected");

		const ci = parseRule({ name: "CI", trigger: { type: "ci_failed" } }) as AutomationRule;
		writeRules(project, [ci]);
		await scheduler.run(project);
		expect(readLedger(project).statuses[ci.id].lastError).toBe("no_ci_provider");
	});

	it("skips projects without an enabled rule", async () => {
		schedule(false);
		const readSource = vi.fn();
		const scheduler = new AutomationScheduler({ readSource } as unknown as RunDeps, () => window as never);
		await scheduler.runAll();
		expect(readSource).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});
});
