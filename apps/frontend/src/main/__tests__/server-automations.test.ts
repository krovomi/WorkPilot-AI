/**
 * A server project's automations are read and changed on the server, by
 * project id; what the server answers is checked again before the panel
 * sees it, and a rule id reaches a URL only with the id's shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock("../server-connection", () => ({ authedFetch }));

import {
	deleteServerAutomation,
	getServerAutomations,
	runServerAutomations,
	saveServerAutomation,
	toAutomationsState,
} from "../server-automations";

const project = { id: "proj-1", name: "Shop" } as Project;
const rule = {
	id: "r-000000000001",
	name: "Issues",
	enabled: true,
	trigger: { type: "issue_labeled", label: "wp" },
	draft: true,
	dailyCap: 3,
	createdAt: "2026-11-01T08:00:00.000Z",
};

beforeEach(() => {
	authedFetch.mockReset();
	authedFetch.mockResolvedValue({ ok: true, data: { rules: [rule], statuses: {}, activity: [] } });
});

describe("server automations", () => {
	it("calls the server's routes by project id", async () => {
		await getServerAutomations(project);
		await saveServerAutomation(project, { name: "Issues" });
		await deleteServerAutomation(project, rule.id);
		await runServerAutomations(project);
		expect(authedFetch.mock.calls.map(([url, method]) => `${method} ${url}`)).toEqual([
			"GET /api/board/automations?project_id=proj-1",
			"POST /api/board/automations/rules?project_id=proj-1",
			"DELETE /api/board/automations/rules/r-000000000001?project_id=proj-1",
			"POST /api/board/automations/run?project_id=proj-1",
		]);
	});

	it("refuses a malformed rule id or rule before any request", async () => {
		expect(await deleteServerAutomation(project, "../../admin")).toEqual({ success: false, error: "Unknown rule" });
		expect((await saveServerAutomation(project, "rule")).success).toBe(false);
		expect(authedFetch).not.toHaveBeenCalled();
	});

	it("passes the server's refusal on as it is", async () => {
		authedFetch.mockResolvedValue({ ok: false, error: "Missing permission: agent.execute" });
		expect(await saveServerAutomation(project, { name: "x" })).toEqual({
			success: false,
			error: "Missing permission: agent.execute",
		});
	});

	it("checks what the server sends", () => {
		const state = toAutomationsState({
			rules: [rule, { ...rule, id: "not-an-id" }, { ...rule, id: "r-000000000002", trigger: { type: "run_shell" } }],
			statuses: {
				[rule.id]: { createdToday: 2, deferred: -1, lastError: "token_missing", lastRunAt: "2026-11-02T10:00:00Z" },
				"r-999999999999": { createdToday: 1, deferred: 0 },
			},
			owners: { [rule.id]: "Ada", "r-999999999999": "Eve" },
			activity: [
				{ at: "2026-11-02T10:00:00Z", ruleId: rule.id, ruleName: "Issues", outcome: "created", subject: "#7", url: "javascript:alert(1)" },
				{ outcome: "created" },
			],
		});
		expect(state?.rules.map((r) => r.id)).toEqual([rule.id]);
		expect(state?.statuses).toEqual({
			[rule.id]: { createdToday: 2, deferred: 0, lastError: "token_missing", lastRunAt: "2026-11-02T10:00:00Z" },
		});
		expect(state?.owners).toEqual({ [rule.id]: "Ada" });
		expect(state?.activity).toHaveLength(1);
		expect(state?.activity[0].url).toBeUndefined();
		expect(state?.runsOn).toBe("server");
		expect(toAutomationsState({ rules: "no" })).toBeNull();
	});
});
