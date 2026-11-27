/**
 * Page activity and usage settings in server mode: a view is counted only
 * when it is a known view, the person is signed in to a server and their
 * organization turned page activity on; counts go in one batch and what was
 * not sent stays; a sign-out or another organization starts from nothing;
 * settings are checked with the server's bounds before they leave.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	isServerMode: vi.fn(() => true),
	getAccessToken: vi.fn<() => string | null>(() => "access"),
	getActiveOrgId: vi.fn<() => string | null>(() => "org-a"),
	getAuthState: vi.fn(() => ({ user: { id: "u-1" } as { id: string } | null })),
}));
vi.mock("../server-connection", () => mocks);

import {
	FLUSH_INTERVAL_MS,
	flushPageActivity,
	getUsageSettings,
	notePageVisit,
	setUsageSettings,
	stopPageActivity,
} from "../server-usage";

const DAY = new Date("2026-11-27T10:00:00Z");

function answers(...replies: unknown[]) {
	for (const reply of replies) mocks.authedFetch.mockResolvedValueOnce(reply);
}

beforeEach(() => {
	stopPageActivity();
	mocks.authedFetch.mockReset();
	mocks.isServerMode.mockReturnValue(true);
	mocks.getAccessToken.mockReturnValue("access");
	mocks.getActiveOrgId.mockReturnValue("org-a");
	mocks.getAuthState.mockReturnValue({ user: { id: "u-1" } });
});

afterEach(() => {
	stopPageActivity();
	vi.useRealTimers();
});

describe("notePageVisit", () => {
	it("counts a known view once the organization has page activity on", async () => {
		answers({ ok: true, data: { enabled: true } });
		expect(await notePageVisit("kanban", DAY)).toBe(true);
		expect(await notePageVisit("kanban", DAY)).toBe(true);
		expect(await notePageVisit("roadmap", DAY)).toBe(true);
		// Asked once for this person.
		expect(mocks.authedFetch).toHaveBeenCalledTimes(1);
		expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/page-activity", "GET");

		answers({ ok: true, data: { enabled: true, recorded: 3 } });
		expect(await flushPageActivity()).toBe(3);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith("/users/me/page-activity", "POST", {
			client: "desktop",
			visits: [
				{ day: "2026-11-27", page: "kanban", count: 2 },
				{ day: "2026-11-27", page: "roadmap", count: 1 },
			],
		});
	});

	it("counts nothing for an unknown name, in local mode, signed out or turned off", async () => {
		expect(await notePageVisit("projects/../secret", DAY)).toBe(false);
		expect(await notePageVisit(42, DAY)).toBe(false);
		mocks.isServerMode.mockReturnValue(false);
		expect(await notePageVisit("kanban", DAY)).toBe(false);
		mocks.isServerMode.mockReturnValue(true);
		mocks.getAuthState.mockReturnValue({ user: null });
		expect(await notePageVisit("kanban", DAY)).toBe(false);
		mocks.getAuthState.mockReturnValue({ user: { id: "u-1" } });
		expect(mocks.authedFetch).not.toHaveBeenCalled();

		answers({ ok: true, data: { enabled: false } });
		expect(await notePageVisit("kanban", DAY)).toBe(false);
		// A server that cannot answer counts as off.
		stopPageActivity();
		answers({ ok: false, error: "offline" });
		expect(await notePageVisit("kanban", DAY)).toBe(false);
	});

	it("starts from nothing for another person or organization", async () => {
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("kanban", DAY);
		mocks.getActiveOrgId.mockReturnValue("org-b");
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("insights", DAY);
		answers({ ok: true, data: { enabled: true, recorded: 1 } });
		await flushPageActivity();
		expect(mocks.authedFetch.mock.calls.at(-1)?.[2]).toEqual({
			client: "desktop",
			visits: [{ day: "2026-11-27", page: "insights", count: 1 }],
		});
	});

	it("drops a state answered for a person who signed out meanwhile", async () => {
		let reply: (value: unknown) => void = () => undefined;
		mocks.authedFetch.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const pending = notePageVisit("kanban", DAY);
		mocks.getAuthState.mockReturnValue({ user: { id: "u-2" } });
		answers({ ok: true, data: { enabled: false } });
		await notePageVisit("kanban", DAY);
		reply({ ok: true, data: { enabled: true } });
		expect(await pending).toBe(false);
	});

	it("keeps at most a batch of distinct pages", async () => {
		answers({ ok: true, data: { enabled: true } });
		const pages = (await import("../../shared/constants/page-activity")).PAGE_ACTIVITY_PAGES;
		for (let day = 0; day < 3; day++) {
			for (const page of pages) {
				await notePageVisit(page, new Date(DAY.getTime() + day * 86_400_000));
			}
		}
		answers({ ok: true, data: { enabled: true, recorded: 200 } });
		await flushPageActivity();
		const body = mocks.authedFetch.mock.calls.at(-1)?.[2] as { visits: unknown[] };
		expect(body.visits).toHaveLength(200);
	});
});

describe("flushPageActivity", () => {
	it("keeps what could not be sent, and what was counted while sending", async () => {
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("kanban", DAY);
		answers({ ok: false, error: "offline" });
		expect(await flushPageActivity()).toBe(0);

		let reply: (value: unknown) => void = () => undefined;
		mocks.authedFetch.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const sending = flushPageActivity();
		await notePageVisit("kanban", DAY);
		reply({ ok: true, data: { enabled: true, recorded: "?" } });
		expect(await sending).toBe(0);

		answers({ ok: true, data: { enabled: true, recorded: 1 } });
		await flushPageActivity();
		expect(mocks.authedFetch.mock.calls.at(-1)?.[2]).toEqual({
			client: "desktop",
			visits: [{ day: "2026-11-27", page: "kanban", count: 1 }],
		});
	});

	it("sends one batch at a time", async () => {
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("kanban", DAY);
		let reply: (value: unknown) => void = () => undefined;
		mocks.authedFetch.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const first = flushPageActivity();
		expect(await flushPageActivity()).toBe(0);
		reply({ ok: true, data: { enabled: true, recorded: 1 } });
		expect(await first).toBe(1);
		expect(mocks.authedFetch).toHaveBeenCalledTimes(2);
	});

	it("drops counts erased while a batch was on its way", async () => {
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("kanban", DAY);
		let reply: (value: unknown) => void = () => undefined;
		mocks.authedFetch.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const sending = flushPageActivity();
		// Turned off by this administrator meanwhile: the counts are dropped.
		answers({ ok: true, data: {} }, { ok: true, data: { enabled: false } });
		await setUsageSettings({ page_activity: false });
		expect(await notePageVisit("kanban", DAY)).toBe(false);
		reply({ ok: true, data: { enabled: false, recorded: 0 } });
		await sending;
		answers({ ok: true, data: { enabled: true } });
		expect(await flushPageActivity()).toBe(0);
		expect(mocks.authedFetch.mock.calls.at(-1)?.[1]).toBe("GET");
	});

	it("counts for a person acting in no organization", async () => {
		mocks.getActiveOrgId.mockReturnValue(null);
		answers({ ok: true, data: { enabled: false } });
		expect(await notePageVisit("kanban", DAY)).toBe(false);
	});

	it("stops counting when the server says page activity is off", async () => {
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("kanban", DAY);
		await notePageVisit("roadmap", DAY);
		let reply: (value: unknown) => void = () => undefined;
		mocks.authedFetch.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const sending = flushPageActivity();
		await notePageVisit("insights", DAY);
		reply({ ok: true, data: { enabled: false, recorded: 0 } });
		await sending;
		expect(await notePageVisit("kanban", DAY)).toBe(false);
		// With nothing to send, it asks again whether page activity is on.
		answers({ ok: true, data: { enabled: true } });
		expect(await flushPageActivity()).toBe(0);
		expect(await notePageVisit("kanban", DAY)).toBe(true);
	});

	it("sends nothing signed out, and drops an answer for someone else", async () => {
		mocks.getAccessToken.mockReturnValue(null);
		expect(await flushPageActivity()).toBe(0);
		mocks.getAccessToken.mockReturnValue("access");
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("kanban", DAY);
		let reply: (value: unknown) => void = () => undefined;
		mocks.authedFetch.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const sending = flushPageActivity();
		mocks.getAuthState.mockReturnValue({ user: { id: "u-2" } });
		answers({ ok: true, data: { enabled: false } });
		await notePageVisit("kanban", DAY);
		reply({ ok: true, data: { enabled: true, recorded: 1 } });
		expect(await sending).toBe(0);
	});

	it("runs every few minutes once a view was counted", async () => {
		vi.useFakeTimers();
		answers({ ok: true, data: { enabled: true } });
		await notePageVisit("kanban", DAY);
		answers({ ok: true, data: { enabled: true, recorded: 1 } });
		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/users/me/page-activity",
			"POST",
			expect.anything(),
		);
	});
});

describe("usage settings", () => {
	const SAVED = {
		page_activity: true,
		page_activity_since: "2026-11-27T10:00:00Z",
		usage_retention_days: null,
		page_activity_retention_days: 90,
		defaults: { usage_retention_days: 365, page_activity_retention_days: 183 },
	};

	it("reads them from the server", async () => {
		answers({ ok: true, data: SAVED });
		expect(await getUsageSettings()).toEqual({ ok: true, data: SAVED });
		expect(mocks.authedFetch).toHaveBeenCalledWith("/admin/usage/settings", "GET");
	});

	it("sends only checked fields, and asks page activity again after", async () => {
		answers({ ok: true, data: { enabled: false } });
		await notePageVisit("kanban", DAY);
		answers({ ok: true, data: SAVED });
		const saved = await setUsageSettings({
			page_activity: true,
			page_activity_retention_days: 90,
			extra: "dropped",
		});
		expect(saved.ok).toBe(true);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith("/admin/usage/settings", "PUT", {
			page_activity: true,
			usage_retention_days: null,
			page_activity_retention_days: 90,
		});
		answers({ ok: true, data: { enabled: true } });
		expect(await notePageVisit("kanban", DAY)).toBe(true);
	});

	it("saves signed out without counting anything", async () => {
		answers({ ok: false, error: "Not authenticated" });
		expect((await setUsageSettings({ page_activity: false })).ok).toBe(false);
		answers({ ok: true, data: SAVED });
		expect((await setUsageSettings({ page_activity: true })).ok).toBe(true);
	});

	it.each([
		[null],
		[{ page_activity: "yes" }],
		[{ page_activity: true, usage_retention_days: 7 }],
		[{ page_activity: true, usage_retention_days: 3651 }],
		[{ page_activity: true, page_activity_retention_days: 40.5 }],
		[{ page_activity: true, page_activity_retention_days: "90" }],
	])("refuses %j before it leaves", async (body) => {
		expect(await setUsageSettings(body)).toEqual({
			ok: false,
			error: "Invalid usage settings",
		});
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});
});
