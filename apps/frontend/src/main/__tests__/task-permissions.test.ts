/**
 * The questions ACP agents ask, held by main for the card. A question comes
 * from the build's stdout, where an agent's text can reach: the registry must
 * never let an answer through that the build did not ask for.
 */
import { describe, expect, it } from "vitest";
import {
	ANSWER_PREFIX,
	parsePermissionRequest,
	resolvedRequestId,
	TaskPermissionRegistry,
} from "../task-permissions";

const REQUEST = {
	requestId: "0d9c1f9e-3b0a-4c43-9c44-3c1b6c0e9a11",
	agent: "Gemini CLI",
	title: "Shell: npm install",
	kind: "execute",
	options: [
		{ optionId: "proceed_once", name: "Allow", kind: "allow_once" },
		{ optionId: "cancel", name: "Reject", kind: "reject_once" },
	],
	locations: [],
	expiresAt: "2026-10-26T12:30:00+00:00",
};

describe("parsePermissionRequest", () => {
	it("reads a well-formed question and attaches the task", () => {
		expect(parsePermissionRequest("task-1", { request: REQUEST }, "proj")).toEqual({
			...REQUEST,
			taskId: "task-1",
			projectId: "proj",
		});
	});

	it.each([
		["no options", { ...REQUEST, options: [] }],
		["an unknown option kind", { ...REQUEST, options: [{ ...REQUEST.options[0], kind: "always" }] }],
		["a request id with a quote", { ...REQUEST, requestId: 'abc"defgh' }],
		["an option id with a space", { ...REQUEST, options: [{ ...REQUEST.options[0], optionId: "a b" }] }],
		["an overlong title", { ...REQUEST, title: "x".repeat(301) }],
		["too many locations", { ...REQUEST, locations: Array(11).fill("/p") }],
	])("refuses %s", (_label, request) => {
		expect(parsePermissionRequest("task-1", { request })).toBeNull();
	});

	it("reads the request id a resolution withdraws", () => {
		expect(resolvedRequestId({ requestId: REQUEST.requestId })).toBe(REQUEST.requestId);
		expect(resolvedRequestId({ requestId: 42 })).toBeNull();
	});
});

describe("TaskPermissionRegistry", () => {
	const held = () => {
		const registry = new TaskPermissionRegistry();
		const request = parsePermissionRequest("task-1", { request: REQUEST });
		if (!request) throw new Error("fixture rejected");
		registry.add(request);
		return registry;
	};

	it("hands back the line for an offered option", () => {
		const answer = held().answer("task-1", REQUEST.requestId, "proceed_once");
		expect(answer).toEqual({
			line: `${ANSWER_PREFIX}{"requestId":"${REQUEST.requestId}","optionId":"proceed_once"}\n`,
		});
	});

	it("refuses an option the question did not offer", () => {
		expect(held().answer("task-1", REQUEST.requestId, "proceed_always")).toEqual({
			ok: false,
			reason: "invalid_option",
		});
	});

	it("refuses a question it does not hold, or held by another task", () => {
		const registry = held();
		expect(registry.answer("task-2", REQUEST.requestId, "proceed_once")).toEqual({
			ok: false,
			reason: "not_pending",
		});
		expect(registry.answer("task-1", "ffffffff-0000", "proceed_once")).toEqual({
			ok: false,
			reason: "not_pending",
		});
		expect(registry.answer(1, REQUEST.requestId, "proceed_once")).toEqual({
			ok: false,
			reason: "not_pending",
		});
	});

	it("keeps the question until the build resolves it", () => {
		const registry = held();
		registry.answer("task-1", REQUEST.requestId, "proceed_once");
		expect(registry.list()).toHaveLength(1);
		expect(registry.remove("task-1", REQUEST.requestId)).toBe(true);
		expect(registry.list()).toEqual([]);
		expect(registry.remove("task-1", REQUEST.requestId)).toBe(false);
	});

	it("drops every question of a task whose process exits", () => {
		const registry = held();
		expect(registry.clearTask("task-1").map((r) => r.requestId)).toEqual([REQUEST.requestId]);
		expect(registry.answer("task-1", REQUEST.requestId, "proceed_once")).toEqual({
			ok: false,
			reason: "not_pending",
		});
	});
});
