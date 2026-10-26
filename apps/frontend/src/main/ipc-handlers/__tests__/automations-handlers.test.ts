/**
 * The automations channels take a project id and a rule as data. Main
 * resolves the project, checks the rule, refuses an id it did not issue,
 * and forgets a deleted rule's history.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { AutomationsState, Project } from "../../../shared/types";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	projects: new Map<string, unknown>(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => state.projects.get(id),
		getProjects: () => [...state.projects.values()],
		getTasks: () => [],
		invalidateTasksCache: vi.fn(),
	},
}));

import { readLedger, writeLedger } from "../../automations/store";
import { registerAutomationsHandlers } from "../automations-handlers";

const run = vi.fn(async () => ({ created: 0, errors: 0 }));
registerAutomationsHandlers({} as never, () => null, () => ({ start: vi.fn(), run }) as never);

type Result = { success: boolean; error?: string; data?: AutomationsState };
const call = (channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args) as Promise<Result>;

let root: string;
let project: Project;
const rule = { name: "Issues", trigger: { type: "issue_labeled", label: "wp" } };

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "automations-ipc-"));
	project = { id: "p1", name: "p", path: root, autoBuildPath: ".workpilot" } as unknown as Project;
	state.projects.clear();
	state.projects.set("p1", project);
	state.projects.set("bare", { ...project, id: "bare", autoBuildPath: "" });
	run.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("automations handlers", () => {
	it("saves a checked rule and lists it", async () => {
		const saved = await call(IPC_CHANNELS.AUTOMATIONS_SAVE, "p1", rule);
		expect(saved.success).toBe(true);
		expect(saved.data?.rules).toHaveLength(1);
		const listed = await call(IPC_CHANNELS.AUTOMATIONS_GET, "p1");
		expect(listed.data?.rules[0]).toMatchObject({ name: "Issues", draft: true });
	});

	it("refuses an unknown project, an uninitialized one, a bad rule and a foreign id", async () => {
		expect(await call(IPC_CHANNELS.AUTOMATIONS_GET, "nope")).toMatchObject({ success: false });
		expect(await call(IPC_CHANNELS.AUTOMATIONS_GET, { path: "/etc" })).toMatchObject({ success: false });
		expect(await call(IPC_CHANNELS.AUTOMATIONS_SAVE, "bare", rule)).toMatchObject({
			success: false,
			error: expect.stringMatching(/Initialize/),
		});
		expect(
			await call(IPC_CHANNELS.AUTOMATIONS_SAVE, "p1", { ...rule, trigger: { type: "shell" } }),
		).toMatchObject({ success: false, error: "Unknown trigger" });
		expect(await call(IPC_CHANNELS.AUTOMATIONS_SAVE, "p1", { ...rule, id: "r-aaaaaaaaaaaa" })).toMatchObject({
			success: false,
			error: "Unknown rule",
		});
		expect((await call(IPC_CHANNELS.AUTOMATIONS_GET, "p1")).data?.rules).toEqual([]);
	});

	it("edits a rule in place, keeping its id", async () => {
		const id = (await call(IPC_CHANNELS.AUTOMATIONS_SAVE, "p1", rule)).data?.rules[0].id;
		const edited = await call(IPC_CHANNELS.AUTOMATIONS_SAVE, "p1", { ...rule, id, enabled: false });
		expect(edited.data?.rules).toEqual([expect.objectContaining({ id, enabled: false })]);
	});

	it("forgets a deleted rule's history", async () => {
		const id = (await call(IPC_CHANNELS.AUTOMATIONS_SAVE, "p1", rule)).data?.rules[0].id as string;
		const ledger = readLedger(project);
		ledger.seen["github-issue:a/b#1"] = { ruleId: id, at: "x", outcome: "created", specId: "001-x" };
		ledger.statuses[id] = { createdToday: 1, deferred: 0 };
		writeLedger(project, ledger);

		expect(await call(IPC_CHANNELS.AUTOMATIONS_DELETE, "p1", "../x")).toMatchObject({ success: false });
		const deleted = await call(IPC_CHANNELS.AUTOMATIONS_DELETE, "p1", id);
		expect(deleted.data?.rules).toEqual([]);
		expect(readLedger(project).seen).toEqual({});
		expect(readLedger(project).statuses).toEqual({});
	});

	it("runs a pass on demand for the named project only", async () => {
		await call(IPC_CHANNELS.AUTOMATIONS_RUN, "p1");
		expect(run).toHaveBeenCalledWith(project);
		expect(await call(IPC_CHANNELS.AUTOMATIONS_RUN, "nope")).toMatchObject({ success: false });
		expect(run).toHaveBeenCalledTimes(1);
	});
});
