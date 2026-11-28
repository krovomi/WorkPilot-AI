/**
 * The Usage tab's calls: only a view from the closed list, days and filters
 * matching the server's own patterns, and an id or address of a sane shape
 * reach the URL; anything else is refused before it leaves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true, data: "answer" })));
vi.mock("../server-connection", () => ({ authedFetch: fetchMock }));

import {
	askedOf,
	eraseAccount,
	exportMyUsage,
	exportUsage,
	getMyUsage,
	getUsageNotice,
	getUsagePerson,
	getUsageView,
	markUsageNoticeSeen,
} from "../server-usage-views";

const INVALID = { ok: false, error: "Invalid usage query" };
const ID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";

beforeEach(() => fetchMock.mockClear());

describe("askedOf", () => {
	it("keeps the filters it knows, in the organization or the platform", () => {
		expect(askedOf(undefined)).toEqual({ prefix: "/admin/usage", search: "" });
		expect(
			askedOf({ start: "2026-11-01", end: "2026-11-27", provider: "", model: null, user_id: ID }),
		).toEqual({
			prefix: "/admin/usage",
			search: `?start=2026-11-01&end=2026-11-27&user_id=${ID}`,
		});
		expect(askedOf({ platform: true, model: "claude-x/v1@a" })).toEqual({
			prefix: "/admin/platform/usage",
			search: "?model=claude-x%2Fv1%40a",
		});
		expect(askedOf({ platform: false })?.prefix).toBe("/admin/usage");
	});

	it("refuses anything off", () => {
		expect(askedOf([])).toBeNull();
		expect(askedOf("start=1")).toBeNull();
		expect(askedOf({ start: "27/11/2026" })).toBeNull();
		expect(askedOf({ project_id: "../etc" })).toBeNull();
		expect(askedOf({ provider: 3 })).toBeNull();
		expect(askedOf({ platform: "yes" })).toBeNull();
	});
});

describe("usage calls", () => {
	it("read a view, a person, an export, as the server serves them", async () => {
		await getUsageView("people", { start: "2026-11-01" });
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/people?start=2026-11-01", "GET");
		await getUsagePerson(ID, { platform: true });
		expect(fetchMock).toHaveBeenLastCalledWith(`/admin/platform/usage/people/${ID}`, "GET");
		await exportUsage("failures", {});
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/admin/usage/export?view=failures",
			"GET",
			undefined,
			"text",
		);
		await exportUsage("daily", { end: "2026-11-27" });
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/admin/usage/export?end=2026-11-27&view=daily",
			"GET",
			undefined,
			"text",
		);
	});

	it("refuse a view, a person or a query it does not know", async () => {
		expect(await getUsageView("secrets", {})).toEqual(INVALID);
		expect(await getUsageView("summary", { start: "x" })).toEqual(INVALID);
		expect(await getUsagePerson("../me", {})).toEqual(INVALID);
		expect(await getUsagePerson(42, {})).toEqual(INVALID);
		expect(await getUsagePerson(ID, { end: "x" })).toEqual(INVALID);
		expect(await exportUsage("summary", {})).toEqual(INVALID);
		expect(await exportUsage("daily", { model: "a b" })).toEqual(INVALID);
		expect(await getMyUsage({ start: "x" })).toEqual(INVALID);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("read and export the person's own usage, and the notice", async () => {
		await getMyUsage({ start: "2026-11-01", platform: true });
		expect(fetchMock).toHaveBeenLastCalledWith("/users/me/usage?start=2026-11-01", "GET");
		await exportMyUsage();
		expect(fetchMock).toHaveBeenLastCalledWith("/users/me/usage/export", "GET", undefined, "text");
		await getUsageNotice();
		expect(fetchMock).toHaveBeenLastCalledWith("/users/me/usage-notice", "GET");
		await markUsageNoticeSeen();
		expect(fetchMock).toHaveBeenLastCalledWith("/users/me/usage-notice", "POST");
	});

	it("erase an account only with a sane id and a typed address", async () => {
		await eraseAccount(ID, "ada@example.com");
		expect(fetchMock).toHaveBeenLastCalledWith(`/admin/users/${ID}/erase`, "POST", {
			confirm_email: "ada@example.com",
		});
		fetchMock.mockClear();
		const refused = { ok: false, error: "Invalid erase request" };
		expect(await eraseAccount("a/b", "ada@example.com")).toEqual(refused);
		expect(await eraseAccount(1, "ada@example.com")).toEqual(refused);
		expect(await eraseAccount(ID, 7)).toEqual(refused);
		expect(await eraseAccount(ID, "  a ")).toEqual(refused);
		expect(await eraseAccount(ID, `${"a".repeat(320)}@x`)).toEqual(refused);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
