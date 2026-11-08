/**
 * @vitest-environment node
 *
 * Following the parts of a split: a merged PR closes its part and moves the
 * parts stacked on it onto the base; an open, closed or unreadable PR does
 * nothing; a conflict is not retried until the part moves.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../../shared/types";

const state = vi.hoisted(() => ({ tasks: [] as Task[] }));

vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../project-store", () => ({
	projectStore: { getTasks: () => state.tasks, invalidateTasksCache: vi.fn(), getProjects: () => [] },
}));
vi.mock("../../../task-state-manager", () => ({ taskStateManager: {} }));
vi.mock("../../../pr-state", () => ({ readPrState: vi.fn() }));
vi.mock("../../utils", () => ({ safeSendToRenderer: vi.fn() }));
vi.mock("../stack-handlers", () => ({ stackUpdate: vi.fn(), writeMetadata: vi.fn() }));

import type { PrState } from "../../../pr-state";
import { followSplitParts, offlineStrict, type SplitMergeDeps } from "../split-merge-watch";

const project = { id: "p", path: "/repo" } as Project;
const PR = "https://github.com/acme/shop/pull/";

function part(index: number, extra: Partial<Task> = {}, metadata: Record<string, unknown> = {}): Task {
	return {
		id: `012-oauth-part${index}`,
		specId: `012-oauth-part${index}`,
		status: "queue",
		subtasks: [],
		...extra,
		metadata: {
			splitGroup: { parent: "012-oauth", title: "OAuth", index, total: 3 },
			...metadata,
		},
	} as Task;
}

function deps(states: Record<string, PrState>, move: { success: boolean; error?: string } = { success: true }) {
	const calls = {
		read: [] as string[],
		done: [] as string[],
		metadata: [] as Array<[string, Record<string, unknown>]>,
		moved: [] as string[],
		reloads: 0,
	};
	const value: SplitMergeDeps = {
		readState: async (url) => {
			calls.read.push(url);
			return states[url] ?? "unknown";
		},
		markDone: (task) => {
			calls.done.push(task.id);
			// What the state machine persists: the board now sees it done.
			state.tasks = state.tasks.map((t) => (t.id === task.id ? { ...t, status: "done" } : t));
		},
		writeMetadata: (task, _project, patch) => {
			calls.metadata.push([task.id, patch]);
			return true;
		},
		moveOntoBase: async (taskId) => {
			calls.moved.push(taskId);
			return move;
		},
		reload: () => {
			calls.reloads += 1;
		},
		now: () => new Date("2026-11-08T14:00:00Z"),
	};
	return { value, calls };
}

beforeEach(() => {
	state.tasks = [];
});

describe("followSplitParts", () => {
	it("closes a part whose PR was merged and moves the part stacked on it", async () => {
		state.tasks = [
			part(1, { status: "pr_created" }, { prUrl: `${PR}1` }),
			part(2, { status: "in_progress" }, { stackParent: "012-oauth-part1", prUrl: `${PR}2` }),
			part(3, {}, { blockedBy: ["012-oauth-part2"] }),
		];
		const { value, calls } = deps({ [`${PR}1`]: "merged" });
		await expect(followSplitParts(project, value)).resolves.toBe(2);
		expect(calls.done).toEqual(["012-oauth-part1"]);
		expect(calls.metadata).toEqual([["012-oauth-part1", { prMergedAt: "2026-11-08T14:00:00.000Z" }]]);
		expect(calls.moved).toEqual(["012-oauth-part2"]);
		expect(calls.reloads).toBe(1);
	});

	it.each(["open", "closed", "unknown"] as const)("does nothing while the PR is %s", async (prState) => {
		state.tasks = [
			part(1, { status: "pr_created" }, { prUrl: `${PR}1` }),
			part(2, {}, { stackParent: "012-oauth-part1" }),
		];
		const { value, calls } = deps({ [`${PR}1`]: prState });
		await expect(followSplitParts(project, value)).resolves.toBe(0);
		expect(calls.done).toEqual([]);
		expect(calls.moved).toEqual([]);
		expect(calls.reloads).toBe(0);
	});

	it("moves a stacked part whose parent was closed earlier, and asks no forge for a part without a PR", async () => {
		state.tasks = [
			part(1, { status: "done" }),
			part(2, { status: "human_review" }, { stackParent: "012-oauth-part1", stackParentSha: "a".repeat(40) }),
		];
		const { value, calls } = deps({});
		await followSplitParts(project, value);
		expect(calls.read).toEqual([]);
		expect(calls.moved).toEqual(["012-oauth-part2"]);
	});

	it("leaves a move refused for a running agent to the next look, and a conflict until the part moves", async () => {
		const stacked = part(2, {}, { stackParent: "012-oauth-part1", stackParentSha: "b".repeat(40) });
		state.tasks = [part(1, { status: "done" }), stacked];
		const busy = deps({}, { success: false, error: "running" });
		await expect(followSplitParts(project, busy.value)).resolves.toBe(0);
		await followSplitParts(project, busy.value);
		expect(busy.calls.moved).toHaveLength(2);

		const stuck = deps({}, { success: false, error: "conflict" });
		await followSplitParts(project, stuck.value);
		await followSplitParts(project, stuck.value);
		expect(stuck.calls.moved).toHaveLength(1);

		state.tasks = [
			part(1, { status: "done" }),
			part(2, {}, { stackParent: "012-oauth-part1", stackParentSha: "c".repeat(40) }),
		];
		await followSplitParts(project, stuck.value);
		expect(stuck.calls.moved).toHaveLength(2);
	});
});

describe("offlineStrict", () => {
	function projectWith(policy: string | null): string {
		const root = mkdtempSync(path.join(tmpdir(), "split-watch-"));
		if (policy !== null) {
			mkdirSync(path.join(root, ".workpilot"));
			writeFileSync(path.join(root, ".workpilot", "offline-mode.json"), policy);
		}
		return root;
	}

	it("lets a project without a strict policy reach its forge", () => {
		expect(offlineStrict(projectWith(null))).toBe(false);
		expect(offlineStrict(projectWith('{"airgapStrict": false}'))).toBe(false);
		expect(offlineStrict(projectWith("{}"))).toBe(false);
	});

	it("keeps a strict project, or one whose policy cannot be read, off the network", () => {
		expect(offlineStrict(projectWith('{"airgapStrict": true}'))).toBe(true);
		expect(offlineStrict(projectWith('{"airgapStrict": "yes"}'))).toBe(true);
		expect(offlineStrict(projectWith("not json"))).toBe(true);
	});
});
