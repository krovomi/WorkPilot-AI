/**
 * @vitest-environment node
 *
 * The watch itself: a first look a minute after start, then every three
 * minutes; a project under the strict offline mode or without a folder is
 * never looked at; a look still running is not doubled; a failure is logged
 * and the next look still happens. The real dependencies are wired: a merged
 * PR closes its part through the state machine, the stacked part moves with
 * `stackUpdate`, and the board is told to reload.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	projects: [] as Project[],
	tasks: [] as Task[],
	getTasks: vi.fn(),
	invalidate: vi.fn(),
	statusChange: vi.fn(),
	readPrState: vi.fn(),
	stackUpdate: vi.fn(),
	writeMetadata: vi.fn(() => true),
	send: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: state.warn } }));
vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => state.projects,
		getTasks: state.getTasks,
		invalidateTasksCache: state.invalidate,
	},
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: { handleManualStatusChange: state.statusChange },
}));
vi.mock("../../../pr-state", () => ({ readPrState: state.readPrState }));
vi.mock("../../utils", () => ({ safeSendToRenderer: state.send }));
vi.mock("../stack-handlers", () => ({
	stackUpdate: state.stackUpdate,
	writeMetadata: state.writeMetadata,
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import type { AgentManager } from "../../../agent";
import { startSplitMergeWatch, stopSplitMergeWatch } from "../split-merge-watch";

const PR = "https://github.com/acme/shop/pull/1";
const agentManager = { name: "agents" } as unknown as AgentManager;
const getMainWindow = () => null;
let root: string;
let online: Project;
let offline: Project;

function part(index: number, status: string, metadata: Record<string, unknown>): Task {
	return {
		id: `020-split-part${index}`,
		specId: `020-split-part${index}`,
		status,
		subtasks: [],
		metadata: { splitGroup: { parent: "020-split", title: "Split", index, total: 2 }, ...metadata },
	} as unknown as Task;
}

beforeEach(() => {
	vi.useFakeTimers();
	root = mkdtempSync(path.join(tmpdir(), "split-watch-"));
	online = { id: "online", path: path.join(root, "online") } as Project;
	offline = { id: "offline", path: path.join(root, "offline") } as Project;
	mkdirSync(path.join(offline.path, ".workpilot"), { recursive: true });
	writeFileSync(path.join(offline.path, ".workpilot", "offline-mode.json"), '{"airgapStrict": true}');
	state.projects = [offline, { id: "nowhere", path: "" } as Project, online];
	state.tasks = [
		part(1, "pr_created", { prUrl: PR }),
		part(2, "in_progress", { stackParent: "020-split-part1" }),
	];
	for (const fn of [
		state.getTasks,
		state.invalidate,
		state.statusChange,
		state.readPrState,
		state.stackUpdate,
		state.send,
		state.warn,
	]) {
		fn.mockReset();
	}
	state.getTasks.mockImplementation(() => state.tasks);
	state.statusChange.mockImplementation((id: string) => {
		state.tasks = state.tasks.map((t) => (t.id === id ? { ...t, status: "done" } : t));
	});
	state.readPrState.mockResolvedValue("merged");
	state.stackUpdate.mockResolvedValue({ success: true });
});

afterEach(() => {
	stopSplitMergeWatch();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

describe("startSplitMergeWatch", () => {
	it("looks a minute after start, with the real dependencies, on online projects only", async () => {
		startSplitMergeWatch(agentManager, getMainWindow);

		await vi.advanceTimersByTimeAsync(59_000);
		expect(state.readPrState).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.getTasks.mock.calls.every(([id]) => id === "online")).toBe(true);
		expect(state.readPrState).toHaveBeenCalledWith(PR, online);
		expect(state.writeMetadata).toHaveBeenCalledWith(
			expect.objectContaining({ id: "020-split-part1" }),
			online,
			{ prMergedAt: expect.any(String) },
		);
		expect(state.statusChange).toHaveBeenCalledWith(
			"020-split-part1",
			"done",
			expect.objectContaining({ id: "020-split-part1" }),
			online,
		);
		expect(state.stackUpdate).toHaveBeenCalledWith("020-split-part2", agentManager);
		expect(state.invalidate).toHaveBeenCalledWith("online");
		expect(state.send).toHaveBeenCalledWith(
			getMainWindow,
			IPC_CHANNELS.TASK_SPLIT_EVENT,
			"",
			"online",
			0,
		);
	});

	it("looks again every three minutes, and starting twice does not double it", async () => {
		state.readPrState.mockResolvedValue("open");
		startSplitMergeWatch(agentManager, getMainWindow);
		startSplitMergeWatch(agentManager, getMainWindow);

		await vi.advanceTimersByTimeAsync(3 * 60_000);
		// The first look at one minute, the first interval tick at three.
		expect(state.readPrState).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(state.readPrState).toHaveBeenCalledTimes(3);
	});

	it("does not start a look while the previous one is still waiting on a forge", async () => {
		let answer: (value: string) => void = () => undefined;
		state.readPrState.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		startSplitMergeWatch(agentManager, getMainWindow);

		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(state.readPrState).toHaveBeenCalledTimes(1);

		answer("open");
		state.readPrState.mockResolvedValue("open");
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(state.readPrState).toHaveBeenCalledTimes(2);
	});

	it.each([
		[new Error("store unreadable"), "store unreadable"],
		["plain failure", "plain failure"],
	])("logs a failed look and keeps watching: %s", async (thrown, message) => {
		state.getTasks.mockImplementationOnce(() => {
			throw thrown;
		});
		startSplitMergeWatch(agentManager, getMainWindow);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(state.warn).toHaveBeenCalledWith(expect.stringContaining(message));

		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(state.readPrState).toHaveBeenCalled();
	});

	it("stops looking once stopped", async () => {
		startSplitMergeWatch(agentManager, getMainWindow);
		stopSplitMergeWatch();
		stopSplitMergeWatch();

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(state.readPrState).not.toHaveBeenCalled();
	});
});
