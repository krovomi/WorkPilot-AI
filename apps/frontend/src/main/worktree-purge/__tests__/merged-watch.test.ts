/**
 * A merged PR closes its card and frees its worktree; a PR closed without a
 * merge sets its card aside once (when the setting is on); a PR still open or
 * a forge that does not answer changes nothing.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

const { tasks } = vi.hoisted(() => ({ tasks: [] as Task[] }));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../project-store", () => ({
	projectStore: { getTasks: () => tasks, invalidateTasksCache: vi.fn(), getProjects: () => [] },
}));
vi.mock("../../task-state-manager", () => ({ taskStateManager: { handleManualStatusChange: vi.fn() } }));
vi.mock("../../ipc-handlers/task/stack-handlers", () => ({ writeMetadata: vi.fn() }));
vi.mock("../../ipc-handlers/task/split-merge-watch", () => ({ offlineStrict: () => false }));
vi.mock("../../ipc-handlers/utils", () => ({ safeSendToRenderer: vi.fn() }));
vi.mock("../../pr-state", () => ({ readPrState: vi.fn() }));
const { settings } = vi.hoisted(() => ({ settings: { current: undefined as Record<string, unknown> | undefined } }));
vi.mock("../../settings-utils", () => ({ readSettingsFile: () => settings.current }));
vi.mock("../../ipc-handlers/cicd-triggers-handlers", () => ({ autoTriggerForTask: vi.fn() }));
vi.mock("../../ci-pipeline-service", () => ({ ciPipelineService: { refreshAfterMerge: vi.fn() } }));
vi.mock("../purge", () => ({
	mergedSpecIds: (_p: Project, list: Task[]) =>
		list.filter((t) => t.metadata?.prMergedAt).map((t) => t.specId),
	purgeWorktrees: vi.fn(),
}));

import { taskStateManager } from "../../task-state-manager";
import {
	abandonClosedPrs,
	cardsAwaitingMerge,
	closeMergedCard,
	followMergedPrs,
	type MergedWatchDeps,
} from "../merged-watch";

const project = { id: "p1", path: "/p" } as Project;
const card = (specId: string, extra: Record<string, unknown> = {}): Task =>
	({
		id: specId,
		specId,
		title: specId,
		status: "pr_created",
		prUrl: `https://github.com/o/r/pull/${specId.length}`,
		metadata: {},
		...extra,
	}) as unknown as Task;

type D = MergedWatchDeps;
let deps: D & {
	readState: Mock<D["readState"]>;
	markDone: Mock<D["markDone"]>;
	writeMetadata: Mock<D["writeMetadata"]>;
	purge: Mock<D["purge"]>;
	reload: Mock<D["reload"]>;
};

beforeEach(() => {
	tasks.length = 0;
	deps = {
		readState: vi.fn<D["readState"]>(async () => "open"),
		markDone: vi.fn<D["markDone"]>(),
		writeMetadata: vi.fn<D["writeMetadata"]>((task, _p, patch) => {
			Object.assign(task.metadata as object, patch);
			return true;
		}),
		purge: vi.fn<D["purge"]>(async (_p, _t, specIds) =>
			specIds.map((specId) => ({ specId, purged: true, bytes: 2048 })),
		),
		reload: vi.fn<D["reload"]>(),
		now: () => new Date("2026-11-09T12:00:00Z"),
	};
});

describe("cardsAwaitingMerge", () => {
	it("follows local cards with a PR waiting for review, not split parts or server cards", () => {
		const list = [
			card("001-pr"),
			card("002-review", { status: "human_review" }),
			card("003-done", { status: "done" }),
			card("004-part", { metadata: { splitGroup: { parent: "x", index: 1, total: 2 } } }),
			card("server:005"),
			card("006-no-pr", { prUrl: undefined }),
			card("007-merged", { metadata: { prMergedAt: "x" } }),
		];
		expect(cardsAwaitingMerge(list).map((t) => t.specId)).toEqual(["001-pr", "002-review"]);
	});
});

describe("followMergedPrs", () => {
	it("closes the card of a merged PR and purges its worktree", async () => {
		tasks.push(card("001-pr"), card("002-open"));
		deps.readState.mockImplementation(async (url) => (url.endsWith("/6") ? "merged" : "open"));

		const result = await followMergedPrs(project, deps);

		expect(deps.writeMetadata).toHaveBeenCalledWith(tasks[0], project, { prMergedAt: "2026-11-09T12:00:00.000Z" });
		expect(deps.markDone).toHaveBeenCalledWith(tasks[0], project);
		expect(deps.purge).toHaveBeenCalledWith(project, tasks, ["001-pr"]);
		expect(result).toEqual({ closed: 1, abandoned: 0, purged: 1, freed: 2048 });
		expect(deps.reload).toHaveBeenCalled();
	});

	it("hands each merged card to CI/CD Triggers' on-merge, after closing it", async () => {
		tasks.push(card("001-pr"), card("002-open"));
		deps.readState.mockImplementation(async (url) => (url.endsWith("/6") ? "merged" : "open"));
		const order: string[] = [];
		deps.markDone.mockImplementation(() => void order.push("done"));
		const onMerged = vi.fn(async (task: (typeof tasks)[number]) => void order.push(`ci:${task.specId}`));

		await followMergedPrs(project, { ...deps, onMerged });

		expect(onMerged).toHaveBeenCalledTimes(1);
		expect(onMerged).toHaveBeenCalledWith(tasks[0], project);
		expect(order).toEqual(["done", "ci:001-pr"]);
	});

	it("changes nothing for a PR that is open, closed or unreadable", async () => {
		tasks.push(card("001-pr"), card("002-pr"), card("003-pr"));
		deps.readState
			.mockResolvedValueOnce("open")
			.mockResolvedValueOnce("closed")
			.mockResolvedValueOnce("unknown");

		const result = await followMergedPrs(project, deps);

		expect(deps.markDone).not.toHaveBeenCalled();
		expect(result).toEqual({ closed: 0, abandoned: 0, purged: 0, freed: 0 });
		expect(deps.reload).not.toHaveBeenCalled();
	});

	it("sets aside, once, the card of a PR closed without a merge", async () => {
		tasks.push(card("001-pr"), card("002-pr", { metadata: { prClosedAt: "earlier" } }));
		deps.readState.mockResolvedValue("closed");

		const result = await followMergedPrs(project, { ...deps, abandonClosed: () => true });

		expect(deps.writeMetadata).toHaveBeenCalledTimes(1);
		expect(tasks[0].metadata).toMatchObject({
			abandoned: true,
			abandonedResolution: "pr_closed",
			abandonedAt: "2026-11-09T12:00:00.000Z",
			prClosedAt: "2026-11-09T12:00:00.000Z",
		});
		expect(deps.markDone).not.toHaveBeenCalled();
		expect(result.abandoned).toBe(1);
		expect(deps.reload).toHaveBeenCalled();

		// Resumed by a person: the next look leaves it alone.
		tasks[0].metadata = { ...tasks[0].metadata, abandoned: false };
		deps.writeMetadata.mockClear();
		await followMergedPrs(project, { ...deps, abandonClosed: () => true });
		expect(deps.writeMetadata).not.toHaveBeenCalled();
	});

	it("leaves a closed PR's card in place when the setting is off", async () => {
		tasks.push(card("001-pr"));
		deps.readState.mockResolvedValue("closed");
		const result = await followMergedPrs(project, { ...deps, abandonClosed: () => false });
		expect(deps.writeMetadata).not.toHaveBeenCalled();
		expect(result.abandoned).toBe(0);
	});

	it("forgets the closing of a reopened PR, and resumes a set-aside card once merged", async () => {
		tasks.push(card("001-pr", { metadata: { prClosedAt: "x", abandoned: true } }));
		deps.readState.mockResolvedValueOnce("open");
		await followMergedPrs(project, deps);
		expect(deps.writeMetadata).toHaveBeenCalledWith(tasks[0], project, { prClosedAt: undefined });

		deps.readState.mockResolvedValueOnce("merged");
		await followMergedPrs(project, deps);
		expect(deps.writeMetadata).toHaveBeenLastCalledWith(
			tasks[0],
			project,
			expect.objectContaining({ prMergedAt: "2026-11-09T12:00:00.000Z", abandoned: false }),
		);
		expect(deps.markDone).toHaveBeenCalled();
	});

	it("purges a split part the split watch closed", async () => {
		tasks.push(card("001-part", { status: "done", metadata: { prMergedAt: "x", splitGroup: { parent: "p", index: 1, total: 2 } } }));
		const result = await followMergedPrs(project, deps);
		expect(deps.readState).not.toHaveBeenCalled();
		expect(result.purged).toBe(1);
	});
});

describe("abandonClosedPrs", () => {
	it("is on unless the person turned it off", () => {
		settings.current = undefined;
		expect(abandonClosedPrs()).toBe(true);
		settings.current = { kanbanAbandonClosedPrs: false };
		expect(abandonClosedPrs()).toBe(false);
	});
});

describe("closeMergedCard", () => {
	it("closes the card through the state machine, as the app's doing", () => {
		const task = card("001-pr");
		closeMergedCard(task, project);
		expect(taskStateManager.handleManualStatusChange).toHaveBeenCalledWith(
			"001-pr",
			"done",
			task,
			project,
			"system",
		);
	});
});
