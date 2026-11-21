/**
 * A server card's approval and the approvals lent on a server project: the
 * main process asks the server by ids only and reads its answers field by
 * field, so nothing else of an answer reaches the renderer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	user: { id: "me" } as { id: string } | null,
}));
vi.mock("../server-connection", () => ({
	authedFetch: mocks.authedFetch,
	getAuthState: () => ({ user: mocks.user }),
}));

import {
	createServerDelegation,
	getServerCardApproval,
	isCriticality,
	listServerDelegates,
	listServerDelegations,
	parseApproval,
	parseDelegation,
	revokeServerDelegation,
	setServerCardCriticality,
} from "../server-card-approvals";

const project = { id: "p/1" } as Project;
const card = { project, cardId: "001-a b" };
const APPROVAL = {
	criticality: "high",
	criticalitySource: "set",
	needed: 2,
	count: 1,
	roles: ["security"],
	missingRoles: ["security"],
	approvals: [{ by: "Ann", for: "Bob", at: "2026-11-21T10:00:00+00:00", roles: ["owner"] }],
	complete: false,
	approved: false,
	secret: "never relayed",
};

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.user = { id: "me" };
});

describe("parsing the server's answers", () => {
	it("keeps only the fields of an approval", () => {
		const parsed = parseApproval(APPROVAL);
		expect(parsed).toEqual({
			criticality: "high",
			criticalitySource: "set",
			needed: 2,
			count: 1,
			roles: ["security"],
			missingRoles: ["security"],
			approvals: [{ by: "Ann", for: "Bob", at: "2026-11-21T10:00:00+00:00", roles: ["owner"] }],
			complete: false,
			approved: false,
		});
	});

	it("falls back on anything it does not recognise", () => {
		expect(parseApproval({ criticality: "urgent" })).toBeNull();
		expect(parseApproval({ criticality: "high" })?.approvals).toEqual([]);
		expect(parseApproval(null)).toBeNull();
		expect(parseApproval([])).toBeNull();
		expect(
			parseApproval({
				criticality: "low",
				criticalitySource: "agent",
				needed: -1,
				count: 1.5,
				roles: "owner",
				approvals: [{ by: 3, for: 4, roles: [1, "x"] }, null],
				complete: "yes",
				approved: 1,
			}),
		).toEqual({
			criticality: "low",
			criticalitySource: "default",
			needed: 1,
			count: 0,
			roles: [],
			missingRoles: [],
			approvals: [
				{ by: "", for: null, at: "", roles: ["x"] },
				{ by: "", for: null, at: "", roles: [] },
			],
			complete: false,
			approved: false,
		});
	});

	it("reads a delegation, or nothing", () => {
		expect(
			parseDelegation({
				id: "d1",
				from: { id: "u1", name: "Ann" },
				to: { id: "u2" },
				startsAt: "s",
				endsAt: "e",
				active: true,
			}),
		).toEqual({
			id: "d1",
			from: { id: "u1", name: "Ann" },
			to: { id: "u2", name: "u2" },
			startsAt: "s",
			endsAt: "e",
			active: true,
		});
		expect(parseDelegation({ id: "d1", from: { id: "u1" } })).toBeNull();
		expect(parseDelegation({ from: { id: "u1" }, to: { id: "u2" } })).toBeNull();
	});

	it("knows the three criticalities", () => {
		expect(["low", "medium", "high"].every(isCriticality)).toBe(true);
		expect(isCriticality("urgent")).toBe(false);
	});
});

describe("asking the server", () => {
	it("reads and sets a card's approval by its ids", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: APPROVAL });
		expect((await getServerCardApproval(card)).data?.needed).toBe(2);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/board/cards/001-a%20b/approvals?project_id=p%2F1",
			"GET",
			undefined,
		);
		expect((await setServerCardCriticality(card, "low")).success).toBe(true);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/board/cards/001-a%20b/criticality?project_id=p%2F1",
			"PUT",
			{ criticality: "low" },
		);
	});

	it("passes the server's refusal and refuses an answer it cannot read", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Someone else lowers it" });
		expect(await setServerCardCriticality(card, "low")).toEqual({
			success: false,
			error: "Someone else lowers it",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { criticality: "x" } });
		expect((await getServerCardApproval(card)).success).toBe(false);
	});

	it("lists, lends and ends delegations", async () => {
		const row = { id: "d1", from: { id: "me", name: "Me" }, to: { id: "u2", name: "Bo" } };
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: [row, { id: "bad" }] });
		expect((await listServerDelegations(project)).data?.map((d) => d.id)).toEqual(["d1"]);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/board/delegations?project_id=p%2F1",
			"GET",
		);

		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: row });
		expect(
			(await createServerDelegation(project, { toUserId: "u2", endsAt: "E", startsAt: "S" }))
				.data?.id,
		).toBe("d1");
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/board/delegations?project_id=p%2F1",
			"POST",
			{ to_user_id: "u2", ends_at: "E", starts_at: "S" },
		);
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: row });
		await createServerDelegation(project, { toUserId: "u2", endsAt: "E" });
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/board/delegations?project_id=p%2F1",
			"POST",
			{ to_user_id: "u2", ends_at: "E" },
		);

		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: null });
		expect(await revokeServerDelegation(project, "d 1")).toEqual({ success: true });
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/board/delegations/d%201?project_id=p%2F1",
			"DELETE",
		);
	});

	it("passes refusals and unreadable answers of the delegation routes", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: false, error: "No" });
		expect((await listServerDelegations(project)).error).toBe("No");
		expect((await createServerDelegation(project, { toUserId: "u", endsAt: "E" })).error).toBe(
			"No",
		);
		expect((await revokeServerDelegation(project, "d")).error).toBe("No");
		expect((await listServerDelegates(project)).error).toBe("No");
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { not: "a list" } });
		expect((await listServerDelegations(project)).success).toBe(false);
		expect((await listServerDelegates(project)).success).toBe(false);
		expect((await createServerDelegation(project, { toUserId: "u", endsAt: "E" })).success).toBe(
			false,
		);
	});

	it("offers the project's writers other than the person signed in", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: true,
			data: [
				{ user_id: "me", display_name: "Me", role: "owner" },
				{ user_id: "u2", display_name: "Bo", role: "member" },
				{ user_id: "u3", email: "cy@example.com", role: "owner" },
				{ user_id: "u4", display_name: "Viewer", role: "viewer" },
				{ user_id: "u5", role: "member" },
				{ display_name: "No id", role: "member" },
			],
		});
		expect((await listServerDelegates(project)).data).toEqual([
			{ id: "u2", name: "Bo" },
			{ id: "u3", name: "cy@example.com" },
			{ id: "u5", name: "u5" },
		]);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith("/projects/p%2F1/members", "GET");
		mocks.user = null;
		expect((await listServerDelegates(project)).data?.length).toBe(4);
	});
});
