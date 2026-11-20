/**
 * A project's guardrails: its rules read and edited, saved only over the file
 * they were read from, tested, and checked against a diff; and what the
 * backend reports about them. Answers for a project left behind are dropped.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGuardrailsStore } from "../guardrails-store";

let api: Record<string, ReturnType<typeof vi.fn>>;
const INITIAL = useGuardrailsStore.getState();
const state = () => useGuardrailsStore.getState();
const rule = (id: string, when?: object) => ({ id, description: id, action: "deny", when }) as never;

function deferred() {
	let resolve: (value: unknown) => void = vi.fn();
	let reject: (reason: unknown) => void = vi.fn();
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(async () => {
	useGuardrailsStore.setState(INITIAL, true);
	api = {
		loadGuardrails: vi.fn(async (path: string) => ({ version: 2, rules: [rule(`${path}-r`, { tool: ["Bash"] })] })),
		saveGuardrails: vi.fn().mockResolvedValue(undefined),
		validateGuardrails: vi.fn(async (path: string) => ({ path, errors: [] })),
		getGuardrailActivity: vi.fn(async (path: string) => ({ path, pending: [] })),
		answerGuardrailRequest: vi.fn().mockResolvedValue(undefined),
		checkGuardrailsDiff: vi.fn(async (path: string) => ({ path, violations: [] })),
		testGuardrails: vi.fn(async () => ({ decision: "block" })),
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	await state().load("/a");
	await vi.waitFor(() => expect(state().activity).not.toBeNull());
});

describe("reading the rules", () => {
	it("reads the project's rules and what the backend says about them", () => {
		expect(state()).toMatchObject({
			doc: { version: 2, rules: [{ id: "/a-r", when: { tool: ["Bash"] } }] },
			dirty: false,
			loading: false,
			loadFailed: false,
			policy: { path: "/a" },
			activity: { path: "/a" },
		});
	});

	it("reads an answer without rules as an empty document, and a rule without a condition as matching everything", async () => {
		api.loadGuardrails.mockResolvedValueOnce(null);
		await state().load("/a");
		expect(state().doc).toEqual({ version: 1, rules: [] });
		api.loadGuardrails.mockResolvedValueOnce({ rules: [rule("r")] });
		await state().load("/a");
		expect(state().doc.rules[0].when).toEqual({});
	});

	it("refuses to save over a file it could not read", async () => {
		api.loadGuardrails.mockRejectedValueOnce(new Error("bad yaml"));
		await state().load("/a");
		expect(state()).toMatchObject({ loadFailed: true, loading: false, error: "Error: bad yaml" });
		await state().save("/a");
		expect(api.saveGuardrails).not.toHaveBeenCalled();
	});

	it("has no report or activity the backend could not give", async () => {
		api.validateGuardrails.mockRejectedValueOnce(new Error("x"));
		api.getGuardrailActivity.mockRejectedValueOnce(new Error("x"));
		await state().refreshInsights("/a");
		expect(state()).toMatchObject({ policy: null, activity: null });
	});
});

describe("another project", () => {
	it("does not show the last project's rules while its own load", async () => {
		const slow = deferred();
		api.loadGuardrails.mockReturnValueOnce(slow.promise);
		const loading = state().load("/b");
		expect(state()).toMatchObject({ doc: { rules: [] }, policy: null, activity: null, loading: true });
		slow.resolve({ rules: [rule("b")] });
		await loading;
		expect(state().doc.rules.map((r) => r.id)).toEqual(["b"]);
	});

	it("never saves one project's rules into another's file", async () => {
		const slow = deferred();
		api.loadGuardrails.mockReturnValueOnce(slow.promise);
		const loading = state().load("/b");
		await state().save("/b");
		expect(api.saveGuardrails).not.toHaveBeenCalled();
		slow.resolve({ rules: [] });
		await loading;
		await state().save("/b");
		expect(api.saveGuardrails).toHaveBeenCalledWith("/b", { version: 1, rules: [] });
	});

	it("drops every answer for the project left behind", async () => {
		const rules = deferred();
		const failing = deferred();
		const insights = deferred();
		const diff = deferred();
		const diffFailing = deferred();
		const test = deferred();
		const testFailing = deferred();
		api.loadGuardrails.mockReturnValueOnce(rules.promise).mockReturnValueOnce(failing.promise);
		api.validateGuardrails.mockReturnValueOnce(insights.promise);
		api.checkGuardrailsDiff.mockReturnValueOnce(diff.promise).mockReturnValueOnce(diffFailing.promise);
		api.testGuardrails.mockReturnValueOnce(test.promise).mockReturnValueOnce(testFailing.promise);

		const pending = [
			state().load("/a"),
			state().load("/a"),
			state().refreshInsights("/a"),
			state().checkDiff("/a"),
			state().checkDiff("/a"),
			state().runTest("/a", "Bash", {}),
			state().runTest("/a", "Bash", {}),
		];
		await state().load("/b");
		await vi.waitFor(() => expect(state().activity).toEqual({ path: "/b", pending: [] }));
		// The last project's diff check, still out, does not hold this one's button.
		expect(state().checking).toBe(false);
		rules.resolve({ rules: [rule("late")] });
		failing.reject(new Error("late"));
		insights.resolve({ path: "/a" });
		diff.resolve({ path: "/a" });
		diffFailing.reject(new Error("late"));
		test.resolve({ decision: "late" });
		testFailing.reject(new Error("late"));
		await Promise.all(pending);
		expect(state()).toMatchObject({
			doc: { rules: [{ id: "/b-r" }] },
			loadFailed: false,
			error: null,
			policy: { path: "/b" },
			diffCheck: null,
			checking: false,
			lastTest: null,
		});
	});
});

describe("editing and saving", () => {
	it("adds rules with distinct ids, edits one and deletes another", () => {
		state().addRule();
		state().addRule();
		const [, first, second] = state().doc.rules;
		expect(first).toMatchObject({ action: "warn", when: { tool: ["Write", "Edit"] } });
		expect(first.id).not.toBe(second.id);
		state().updateRule(1, { action: "deny", when: { path_glob: "src/**" } });
		expect(state().doc.rules[1]).toMatchObject({ action: "deny", when: { tool: ["Write", "Edit"], path_glob: "src/**" } });
		state().updateRule(0, { description: "kept" });
		expect(state().doc.rules[0]).toMatchObject({ description: "kept", when: { tool: ["Bash"] } });
		state().deleteRule(2);
		expect(state().doc.rules).toHaveLength(2);
		expect(state().dirty).toBe(true);
	});

	it("saves the rules and reads the backend's report again", async () => {
		state().addRule();
		api.validateGuardrails.mockClear();
		await state().save("/a");
		expect(api.saveGuardrails).toHaveBeenCalledWith("/a", state().doc);
		expect(state()).toMatchObject({ dirty: false, loading: false });
		expect(api.validateGuardrails).toHaveBeenCalledWith("/a");
	});

	it("says why the rules could not be saved, and keeps them unsaved", async () => {
		state().addRule();
		api.saveGuardrails.mockRejectedValueOnce(new Error("read-only"));
		await state().save("/a");
		expect(state()).toMatchObject({ dirty: true, loading: false, error: "Error: read-only" });
	});
});

describe("testing and checking", () => {
	it("tests a tool call against the rules", async () => {
		await state().runTest("/a", "Bash", { command: "rm -rf /" });
		expect(api.testGuardrails).toHaveBeenCalledWith("/a", "Bash", { command: "rm -rf /" });
		expect(state().lastTest).toEqual({ decision: "block" });
		api.testGuardrails.mockRejectedValueOnce(new Error("no runner"));
		await state().runTest("/a", "Bash", {});
		expect(state().error).toBe("Error: no runner");
		state().reset();
		expect(state()).toMatchObject({ lastTest: null, error: null });
	});

	it("checks a diff against the rules", async () => {
		await state().checkDiff("/a", "HEAD~1");
		expect(api.checkGuardrailsDiff).toHaveBeenCalledWith("/a", "HEAD~1");
		expect(state()).toMatchObject({ diffCheck: { path: "/a" }, checking: false });
		api.checkGuardrailsDiff.mockRejectedValueOnce(new Error("not a repo"));
		await state().checkDiff("/a");
		expect(state()).toMatchObject({ error: "Error: not a repo", checking: false });
	});

	it("answers a pending request and reads the activity again, even when the answer fails", async () => {
		api.getGuardrailActivity.mockClear();
		await state().answer("/a", "req1", true);
		expect(api.answerGuardrailRequest).toHaveBeenCalledWith("/a", "req1", true);
		api.answerGuardrailRequest.mockRejectedValueOnce(new Error("expired"));
		await state().answer("/a", "req2", false);
		expect(state().error).toBe("Error: expired");
		expect(api.getGuardrailActivity).toHaveBeenCalledTimes(2);
	});
});
