import { beforeEach, describe, expect, it } from "vitest";
import type { TaskPermissionRequest } from "../../../shared/types/task-permission";
import { pendingPermission, useTaskPermissionStore } from "../task-permission-store";

const request = (taskId: string, requestId: string): TaskPermissionRequest => ({
	requestId,
	taskId,
	agent: "Gemini CLI",
	title: "WriteFile: a.md",
	kind: "edit",
	options: [{ optionId: "proceed_once", name: "Allow", kind: "allow_once" }],
	locations: [],
	expiresAt: "2026-10-26T12:30:00+00:00",
});

beforeEach(() => useTaskPermissionStore.getState().replaceAll([]));

describe("task permission store", () => {
	it("keeps a task's questions oldest first, each once", () => {
		const store = useTaskPermissionStore.getState();
		store.add(request("t", "aaaaaaaa"));
		store.add(request("t", "bbbbbbbb"));
		store.add(request("t", "aaaaaaaa"));
		const { byTask } = useTaskPermissionStore.getState();
		expect(byTask.t.map((r) => r.requestId)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
		expect(pendingPermission(byTask, "t")?.requestId).toBe("aaaaaaaa");
	});

	it("forgets a task once its last question is resolved", () => {
		const store = useTaskPermissionStore.getState();
		store.add(request("t", "aaaaaaaa"));
		store.remove("t", "aaaaaaaa");
		expect(useTaskPermissionStore.getState().byTask).toEqual({});
	});

	it("replaces everything with main's list after a reload", () => {
		const store = useTaskPermissionStore.getState();
		store.add(request("old", "cccccccc"));
		store.replaceAll([request("t", "aaaaaaaa"), request("u", "bbbbbbbb")]);
		expect(Object.keys(useTaskPermissionStore.getState().byTask).sort()).toEqual(["t", "u"]);
	});
});
