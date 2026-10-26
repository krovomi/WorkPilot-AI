/**
 * The route of an ACP question: task event → card and needs-you, and the
 * person's answer → the build's stdin, only once main has checked it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			handlers.set(channel, handler),
	},
}));

const notify = vi.fn();
vi.mock("../../notification-service", () => ({
	notificationService: { notify: (...args: unknown[]) => notify(...args) },
}));

vi.mock("../task/shared", () => ({
	findTaskAndProject: () => ({ task: { title: "Add login" }, project: { id: "proj" } }),
}));

const sent: unknown[][] = [];
vi.mock("../utils", () => ({
	safeSendToRenderer: (_window: unknown, ...args: unknown[]) => sent.push(args),
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { AgentManager } from "../../agent";
import { ANSWER_PREFIX, taskPermissions } from "../../task-permissions";
import {
	clearTaskPermissions,
	handlePermissionTaskEvent,
	registerTaskPermissionHandlers,
} from "../task-permission-handlers";

const REQUEST_ID = "5f0e6c1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const REQUESTED = {
	type: "PERMISSION_REQUESTED",
	request: {
		requestId: REQUEST_ID,
		agent: "Gemini CLI",
		title: "WriteFile: notes.md",
		kind: "edit",
		options: [
			{ optionId: "proceed_once", name: "Allow", kind: "allow_once" },
			{ optionId: "cancel", name: "Reject", kind: "reject_once" },
		],
		locations: ["/project/notes.md"],
		expiresAt: "2026-10-26T12:30:00+00:00",
	},
};
const getMainWindow = () => null;

const writeToTaskStdin = vi.fn(() => true);
registerTaskPermissionHandlers({ writeToTaskStdin } as unknown as AgentManager);
const answer = (...args: unknown[]) =>
	handlers.get(IPC_CHANNELS.TASK_PERMISSION_ANSWER)?.({}, ...args);

beforeEach(() => {
	sent.length = 0;
	notify.mockClear();
	writeToTaskStdin.mockClear();
	writeToTaskStdin.mockReturnValue(true);
	taskPermissions.clearTask("task-1");
});

describe("task permission handlers", () => {
	it("leaves other task events alone", () => {
		expect(handlePermissionTaskEvent("task-1", { type: "CODING_STARTED" }, "proj", getMainWindow)).toBe(false);
		expect(sent).toEqual([]);
	});

	it("shows a question on the card and asks for the person", () => {
		expect(handlePermissionTaskEvent("task-1", REQUESTED, "proj", getMainWindow)).toBe(true);
		expect(sent[0]?.[0]).toBe(IPC_CHANNELS.TASK_PERMISSION_REQUEST);
		expect(notify).toHaveBeenCalledWith({
			kind: "permission",
			taskId: "task-1",
			projectId: "proj",
			taskTitle: "Add login",
		});
		expect(handlers.get(IPC_CHANNELS.TASK_PERMISSION_LIST)?.()).toHaveLength(1);
	});

	it("swallows a malformed question without showing it", () => {
		const forged = { type: "PERMISSION_REQUESTED", request: { requestId: REQUEST_ID } };
		expect(handlePermissionTaskEvent("task-1", forged, "proj", getMainWindow)).toBe(true);
		expect(sent).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("writes a checked answer to the build's stdin", () => {
		handlePermissionTaskEvent("task-1", REQUESTED, "proj", getMainWindow);
		expect(answer("task-1", REQUEST_ID, "proceed_once")).toEqual({ ok: true });
		expect(writeToTaskStdin).toHaveBeenCalledWith(
			"task-1",
			`${ANSWER_PREFIX}{"requestId":"${REQUEST_ID}","optionId":"proceed_once"}\n`,
		);
	});

	it("writes nothing for an option or a question that was not offered", () => {
		handlePermissionTaskEvent("task-1", REQUESTED, "proj", getMainWindow);
		expect(answer("task-1", REQUEST_ID, "proceed_always")).toEqual({ ok: false, reason: "invalid_option" });
		expect(answer("task-2", REQUEST_ID, "proceed_once")).toEqual({ ok: false, reason: "not_pending" });
		expect(writeToTaskStdin).not.toHaveBeenCalled();
	});

	it("says when the build is gone", () => {
		handlePermissionTaskEvent("task-1", REQUESTED, "proj", getMainWindow);
		writeToTaskStdin.mockReturnValue(false);
		expect(answer("task-1", REQUEST_ID, "proceed_once")).toEqual({ ok: false, reason: "process_gone" });
	});

	it("withdraws the question when the build resolves it or exits", () => {
		handlePermissionTaskEvent("task-1", REQUESTED, "proj", getMainWindow);
		handlePermissionTaskEvent(
			"task-1",
			{ type: "PERMISSION_RESOLVED", requestId: REQUEST_ID },
			"proj",
			getMainWindow,
		);
		expect(sent.at(-1)).toEqual([IPC_CHANNELS.TASK_PERMISSION_CLEARED, "task-1", REQUEST_ID]);

		handlePermissionTaskEvent("task-1", REQUESTED, "proj", getMainWindow);
		clearTaskPermissions("task-1", getMainWindow);
		expect(sent.at(-1)).toEqual([IPC_CHANNELS.TASK_PERMISSION_CLEARED, "task-1", REQUEST_ID]);
		expect(answer("task-1", REQUEST_ID, "proceed_once")).toEqual({ ok: false, reason: "not_pending" });
	});
});
