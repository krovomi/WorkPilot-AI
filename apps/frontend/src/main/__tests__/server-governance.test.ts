/**
 * A server project's governance (#353, lot 4): read from the server by project
 * id, rebuilt field by field before the renderer sees it; an answer and a stop
 * only with values from closed lists; the kill switch reaching the projects
 * the person works on, and only their own agents there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { Project } from "../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	isServerMode: vi.fn(() => true),
	getServerProject: vi.fn(),
	listedServerProjects: vi.fn((): Project[] => []),
	save: vi.fn(),
	writeFile: vi.fn(async () => undefined),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("../server-connection", () => ({ authedFetch: mocks.authedFetch, isServerMode: mocks.isServerMode }));
vi.mock("../server-projects", () => ({
	getServerProject: mocks.getServerProject,
	listedServerProjects: mocks.listedServerProjects,
}));
vi.mock("../electron-utils", () => ({ showSaveDialog: mocks.save }));
vi.mock("node:fs/promises", () => ({ writeFile: mocks.writeFile }));
vi.mock("../ipc-handlers/guardrails-handlers", () => ({ runGuardrails: vi.fn() }));
vi.mock("../security/renderer-path", () => ({ resolveKnownProject: vi.fn(() => null) }));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
	},
}));

import { registerGovernanceHandlers } from "../ipc-handlers/governance-handlers";
import {
	answerServerRequest,
	fetchServerAudit,
	fetchServerGovernance,
	reportFrom,
	requestFrom,
	sectionsFrom,
	stopServerAgents,
	stopServerProject,
} from "../server-governance";

function project(id: string, role: "viewer" | "member" | "owner" = "member"): Project {
	return {
		id,
		path: `/mirror/${id}`,
		remote: { repoUrl: "https://x/r.git", defaultBranch: "main", role },
	} as unknown as Project;
}

const shop = project("p-1");
const request = {
	id: "0123456789ab",
	at: "2026-11-20T10:00:00+00:00",
	rules: ["files.requires_review:infra/**"],
	tool: "Write",
	target: { kind: "file", summary: "infra/main.tf" },
	task: "001-a",
	message: "Human approval required",
};

function answered(data: unknown) {
	mocks.authedFetch.mockResolvedValueOnce({ ok: true, data });
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.getServerProject.mockReset();
	mocks.listedServerProjects.mockReset().mockReturnValue([]);
	mocks.isServerMode.mockReset().mockReturnValue(true);
	mocks.save.mockReset();
	mocks.writeFile.mockClear();
	mocks.handlers.clear();
});

describe("the report of a server project", () => {
	it("is read by project id and rebuilt", async () => {
		answered({
			governance: {
				source: "workpilot.policy.yaml",
				schedule: { timezone: "Europe/Paris", allowedHours: ["08:00-19:00"], days: ["mon"], openNow: true },
				files: { forbidden: [".env*"], requiresReview: ["infra/**"], reviewers: ["security", 3] },
				budget: { maxTokensPerHour: 500000, maxTokensPerTask: -1 },
				loopDetection: { maxSameToolCall: 5 },
			},
			errors: ["x".repeat(900)],
			sources: [{ layer: "repository", path: "workpilot.policy.yaml", rules: 2 }, "junk"],
			tokensLastHour: 1234,
			events: [{ id: "e", at: "t", decision: "approved", rules: [], approvedBy: "Ada <u-1>" }],
			metrics: { blocked24h: 2, breakerTrips7d: 1 },
			pending: [request, { ...request, id: "../etc" }, null],
			agents: { mine: 1, project: 3 },
			may: { approve: true, stop: "yes", stopProject: false, export: true },
		});
		const got = await fetchServerGovernance(shop);
		expect(mocks.authedFetch).toHaveBeenCalledWith("/api/features/governance?project_id=p-1", "GET");
		expect(got.success).toBe(true);
		const report = got.data;
		expect(report?.governance?.files.reviewers).toEqual(["security"]);
		expect(report?.governance?.budget).toEqual({ maxTokensPerHour: 500000, maxTokensPerTask: null });
		expect(report?.governance?.loopDetection).toEqual({ maxSameToolCall: 5 });
		expect(report?.errors[0]).toHaveLength(500);
		expect(report?.sources).toEqual([{ layer: "repository", path: "workpilot.policy.yaml", rules: 2 }]);
		expect(report?.events[0].approvedBy).toBe("Ada <u-1>");
		expect(report?.pending.map((r) => r.id)).toEqual(["0123456789ab"]);
		expect(report?.pending[0]).toMatchObject({ targetKind: "file", target: "infra/main.tf" });
		expect(report?.agents).toEqual({ mine: 1, project: 3 });
		// Only a true is a yes.
		expect(report?.may).toEqual({ approve: true, stop: false, stopProject: false, export: true });
	});

	it("says when the server refuses or answers something else", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Missing permission: audit.read" });
		expect(await fetchServerGovernance(shop)).toEqual({ success: false, error: "Missing permission: audit.read" });
		answered("nope");
		expect((await fetchServerGovernance(shop)).success).toBe(false);
	});

	it("reads a policy with nothing in it, and nothing from junk", () => {
		expect(sectionsFrom(null)).toBeNull();
		expect(sectionsFrom({})).toEqual({
			source: "",
			schedule: null,
			files: { forbidden: [], requiresReview: [], reviewers: [] },
			budget: null,
			loopDetection: null,
		});
		expect(sectionsFrom({ schedule: {}, budget: {}, loopDetection: { maxSameToolCall: 0 } })).toMatchObject({
			schedule: { timezone: "UTC", allowedHours: [], openNow: false, localTime: null },
			budget: { maxTokensPerHour: null, maxTokensPerTask: null },
			loopDetection: null,
		});
		expect(requestFrom({ id: "0123456789ab" })).toMatchObject({ targetKind: null, target: null, at: "" });
		expect(reportFrom({})).toMatchObject({ pending: [], agents: { mine: 0, project: 0 }, sources: [] });
		expect(reportFrom([])).toBeNull();
	});

	it("reads the whole trail for an export", async () => {
		answered({ events: [{ id: "e", at: "t", decision: "deny", rules: [] }, { decision: "forged" }] });
		const got = await fetchServerAudit(shop);
		expect(mocks.authedFetch).toHaveBeenCalledWith("/api/features/governance/audit?project_id=p-1", "GET");
		expect(got.data).toHaveLength(1);
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Missing permission: audit.export" });
		expect((await fetchServerAudit(shop)).success).toBe(false);
	});
});

describe("answering a call", () => {
	it("sends a request id and a yes or no, nothing else", async () => {
		answered({ answer: { decision: "approved" } });
		expect(await answerServerRequest(shop, "0123456789ab", true)).toEqual({
			success: true,
			data: { decision: "approved" },
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/governance/approvals/0123456789ab?project_id=p-1",
			"POST",
			{ approved: true },
		);
	});

	it("refuses a forged request id or answer before asking", async () => {
		for (const [id, approved] of [
			["../x", true],
			["0123456789AB", true],
			[42, true],
			["0123456789ab", "yes"],
		] as const) {
			expect((await answerServerRequest(shop, id, approved)).success).toBe(false);
		}
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("passes the server's refusal, and refuses an odd answer", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "workpilot.policy.yaml asks one of these roles" });
		expect((await answerServerRequest(shop, "0123456789ab", true)).error).toMatch(/roles/);
		answered({ answer: { decision: "maybe" } });
		expect((await answerServerRequest(shop, "0123456789ab", false)).success).toBe(false);
	});
});

describe("the kill switch of a server project", () => {
	it("stops with a scope from the closed list", async () => {
		answered({ stoppedRuns: 2, stoppedJobs: 1.5 });
		expect(await stopServerProject(shop, "project")).toEqual({
			success: true,
			data: { stoppedRuns: 2, stoppedJobs: 1 },
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith("/api/features/governance/stop?project_id=p-1", "POST", {
			scope: "project",
		});
		expect((await stopServerProject(shop, "everyone")).success).toBe(false);
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Stopping every agent of the project is its owner's" });
		expect((await stopServerProject(shop, "project")).success).toBe(false);
	});

	it("asks each project the person works on to stop their own agents", async () => {
		mocks.listedServerProjects.mockReturnValue([project("a"), project("b", "owner"), project("c", "viewer")]);
		mocks.authedFetch
			.mockResolvedValueOnce({ ok: true, data: { stoppedRuns: 1, stoppedJobs: 1 } })
			.mockResolvedValueOnce({ ok: false, error: "offline" });
		expect(await stopServerAgents()).toEqual({ stopped: 2, failed: 1 });
		expect(mocks.authedFetch).toHaveBeenCalledTimes(2);
		for (const call of mocks.authedFetch.mock.calls) expect(call[2]).toEqual({ scope: "mine" });
	});

	it("does nothing without a server", async () => {
		mocks.isServerMode.mockReturnValue(false);
		mocks.listedServerProjects.mockReturnValue([project("a")]);
		expect(await stopServerAgents()).toEqual({ stopped: 0, failed: 0 });
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});
});

describe("the server governance channels", () => {
	it("refuse an id that is not a listed server project", async () => {
		registerGovernanceHandlers();
		for (const channel of [
			IPC_CHANNELS.GOVERNANCE_SERVER_REPORT,
			IPC_CHANNELS.GOVERNANCE_SERVER_EXPORT,
			IPC_CHANNELS.GOVERNANCE_SERVER_ANSWER,
			IPC_CHANNELS.GOVERNANCE_SERVER_STOP,
		]) {
			expect(await mocks.handlers.get(channel)?.({}, { projectId: "/etc" })).toEqual({
				success: false,
				error: "Not a project of the server",
			});
			expect(await mocks.handlers.get(channel)?.({}, undefined)).toMatchObject({ success: false });
		}
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("serve a listed server project", async () => {
		mocks.getServerProject.mockReturnValue(shop);
		registerGovernanceHandlers();
		answered({});
		expect(await mocks.handlers.get(IPC_CHANNELS.GOVERNANCE_SERVER_REPORT)?.({}, { projectId: "p-1" })).toMatchObject({
			success: true,
		});
		answered({ answer: { decision: "refused" } });
		expect(
			await mocks.handlers.get(IPC_CHANNELS.GOVERNANCE_SERVER_ANSWER)?.(
				{},
				{ projectId: "p-1", requestId: "0123456789ab", approved: false },
			),
		).toEqual({ success: true, data: { decision: "refused" } });
		answered({ stoppedRuns: 0, stoppedJobs: 0 });
		expect(
			await mocks.handlers.get(IPC_CHANNELS.GOVERNANCE_SERVER_STOP)?.({}, { projectId: "p-1", scope: "mine" }),
		).toEqual({ success: true, data: { stoppedRuns: 0, stoppedJobs: 0 } });
	});

	it("export a server project's trail where the person chose", async () => {
		mocks.getServerProject.mockReturnValue(shop);
		registerGovernanceHandlers();
		const exportServer = mocks.handlers.get(IPC_CHANNELS.GOVERNANCE_SERVER_EXPORT);
		answered({ events: [{ id: "e", at: "t", decision: "deny", rules: [] }] });
		mocks.save.mockResolvedValueOnce({ canceled: false, filePath: "/home/me/audit.json" });
		expect(await exportServer?.({}, { projectId: "p-1", format: "json" })).toEqual({
			success: true,
			data: { filePath: "/home/me/audit.json", count: 1 },
		});
		expect(mocks.writeFile).toHaveBeenCalledWith("/home/me/audit.json", expect.stringContaining('"deny"'), "utf-8");
		// A format outside the list is refused before the server is asked.
		mocks.authedFetch.mockClear();
		expect(await exportServer?.({}, { projectId: "p-1", format: "xlsx" })).toMatchObject({ success: false });
		expect(mocks.authedFetch).not.toHaveBeenCalled();
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Missing permission: audit.export" });
		expect(await exportServer?.({}, { projectId: "p-1", format: "csv" })).toEqual({
			success: false,
			error: "Missing permission: audit.export",
		});
	});
});
