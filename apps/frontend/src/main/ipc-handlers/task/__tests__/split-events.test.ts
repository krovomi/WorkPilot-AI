/**
 * @vitest-environment node
 *
 * A task that became its parts: the board first gets the task's new metadata
 * (read from the main spec or, failing that, the worktree copy), then a
 * reload for the parts. A part count the event does not state as a positive
 * whole number is announced as 0.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ invalidate: vi.fn() }));

vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: state.invalidate },
}));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project, Task } from "../../../../shared/types";
import { TASK_WORKTREE_DIR } from "../../../worktree-paths";
import { announceSplit, splitTotal } from "../split-events";

const SPEC_ID = "002-split";
let root: string;
let mainSpec: string;
let worktreeSpec: string;
let send: ReturnType<typeof vi.fn>;
let getMainWindow: () => BrowserWindow | null;
const task = { id: "task-2", specId: SPEC_ID } as Task;
let project: Project;

const writeMetadata = (dir: string, content: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "task_metadata.json"), content);
};

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "split-events-"));
	mainSpec = path.join(root, ".workpilot", "specs", SPEC_ID);
	worktreeSpec = path.join(root, TASK_WORKTREE_DIR, SPEC_ID, ".workpilot", "specs", SPEC_ID);
	project = { id: "p2", path: root } as Project;
	send = vi.fn();
	const window = {
		isDestroyed: () => false,
		webContents: { isDestroyed: () => false, send },
	};
	getMainWindow = () => window as unknown as BrowserWindow;
	state.invalidate.mockClear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("splitTotal", () => {
	it.each([
		[{ total: 3 }, 3],
		[{ total: 0 }, 0],
		[{ total: -2 }, 0],
		[{ total: 2.5 }, 0],
		[{ total: "3" }, 0],
		[{}, 0],
	])("reads %j as %i parts", (event, expected) => {
		expect(splitTotal(event)).toBe(expected);
	});
});

describe("announceSplit", () => {
	it("sends the new metadata, then the split, after dropping the cached tasks", () => {
		writeMetadata(
			mainSpec,
			JSON.stringify({ splitGroup: "grp-1", archivedAt: "2026-11-15T10:00:00Z", model: "m" }),
		);

		announceSplit(getMainWindow, task, project, { total: 2 });

		expect(state.invalidate).toHaveBeenCalledWith("p2");
		expect(send.mock.calls).toEqual([
			[
				IPC_CHANNELS.TASK_UPDATED_EVENT,
				"task-2",
				{ metadata: { splitGroup: "grp-1", archivedAt: "2026-11-15T10:00:00Z" } },
				"p2",
			],
			[IPC_CHANNELS.TASK_SPLIT_EVENT, "task-2", "p2", 2],
		]);
	});

	it("reads the worktree copy when the main one is broken", () => {
		writeMetadata(mainSpec, "{not json");
		writeMetadata(worktreeSpec, JSON.stringify({ splitGroup: "grp-wt" }));

		announceSplit(getMainWindow, task, project, { total: 3 });

		expect(send.mock.calls[0]).toEqual([
			IPC_CHANNELS.TASK_UPDATED_EVENT,
			"task-2",
			{ metadata: { splitGroup: "grp-wt", archivedAt: undefined } },
			"p2",
		]);
	});

	it.each([
		["no metadata file", null],
		["metadata without a split group", JSON.stringify({ model: "m" })],
		["metadata that is not an object", JSON.stringify(["grp"])],
	])("only announces the split with %s", (_label, content) => {
		if (content !== null) writeMetadata(mainSpec, content);

		announceSplit(getMainWindow, task, project, { total: "many" });

		expect(send.mock.calls).toEqual([[IPC_CHANNELS.TASK_SPLIT_EVENT, "task-2", "p2", 0]]);
	});

	it("sends nothing when the window is gone", () => {
		writeMetadata(mainSpec, JSON.stringify({ splitGroup: "grp-1" }));

		announceSplit(() => null, task, project, { total: 2 });

		expect(send).not.toHaveBeenCalled();
		expect(state.invalidate).toHaveBeenCalledWith("p2");
	});
});
