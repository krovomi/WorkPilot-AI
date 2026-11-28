import { auditDetails, loginMethodKey, MAX_DETAIL_LENGTH, MAX_DETAILS } from "../admin/audit";
import { meterColor, usedShare } from "../admin/QuotaMeters";
import { draftOf, MAX_QUOTA, quotaChanges } from "../admin/quota-draft";
import { byPerson, deviceOf } from "../admin/sessions";
import type { MemberSession, Quota } from "../admin/types";
import { PALETTES } from "../ui/palettes";

const QUOTA: Quota = {
	org_id: "org-a",
	max_users: 10,
	max_projects: null,
	max_concurrent_runs: 2,
	monthly_token_budget: null,
	enforce_hard_stop: false,
	used_users: 3,
	used_projects: 4,
	used_concurrent_runs: 2,
	used_tokens_this_month: 1500,
};

describe("quota meters", () => {
	it("measures the share of a limit, full at a limit of 0, none without a limit", () => {
		expect(usedShare(3, 10)).toBe(0.3);
		expect(usedShare(12, 10)).toBe(1);
		expect(usedShare(-1, 10)).toBe(0);
		expect(usedShare(0, 0)).toBe(1);
		expect(usedShare(5, null)).toBeNull();
	});

	it("turns amber from 80 % and red at the limit", () => {
		const theme = PALETTES.default.light;
		expect(meterColor(theme, 0.5)).toBe(theme.accent);
		expect(meterColor(theme, 0.8)).toBe(theme.warning);
		expect(meterColor(theme, 1)).toBe(theme.danger);
	});
});

describe("the quota form", () => {
	it("starts from the server's limits, empty when unlimited", () => {
		expect(draftOf(QUOTA)).toEqual({
			max_users: "10",
			max_projects: "",
			max_concurrent_runs: "2",
			monthly_token_budget: "",
		});
	});

	it("sends only what changed: a number sets a limit, an empty field lifts it", () => {
		const draft = { ...draftOf(QUOTA), max_users: " 25 ", max_concurrent_runs: "", monthly_token_budget: "0" };
		expect(quotaChanges(QUOTA, draft, true)).toEqual({
			max_users: 25,
			max_concurrent_runs: null,
			monthly_token_budget: 0,
			enforce_hard_stop: true,
		});
		expect(quotaChanges(QUOTA, draftOf(QUOTA), false)).toEqual({});
	});

	it("refuses what is not a whole number, or beyond any real ceiling", () => {
		for (const bad of ["-1", "2.5", "1e3", "ten"]) {
			expect(quotaChanges(QUOTA, { ...draftOf(QUOTA), max_projects: bad }, false)).toBeNull();
		}
		expect(quotaChanges(QUOTA, { ...draftOf(QUOTA), max_projects: String(MAX_QUOTA + 1) }, false)).toBeNull();
	});
});

describe("an audit line", () => {
	it("reads its details in order, bounded in count and length", () => {
		expect(auditDetails(null)).toEqual([]);
		expect(auditDetails({ email: "b@x.io", count: 2, roles: ["qa"], gone: null })).toEqual([
			{ key: "email", value: "b@x.io" },
			{ key: "count", value: "2" },
			{ key: "roles", value: '["qa"]' },
			{ key: "gone", value: "null" },
		]);
		expect(auditDetails({ fn: undefined })).toEqual([{ key: "fn", value: "undefined" }]);
		const long = auditDetails({ text: "x".repeat(MAX_DETAIL_LENGTH + 5) })[0].value;
		expect(long).toHaveLength(MAX_DETAIL_LENGTH);
		expect(long.endsWith("…")).toBe(true);
		const many = Object.fromEntries(Array.from({ length: MAX_DETAILS + 3 }, (_, i) => [`k${i}`, i]));
		expect(auditDetails(many)).toHaveLength(MAX_DETAILS);
	});

	it("names a known sign-in method, and any other as unknown", () => {
		expect(loginMethodKey("entra")).toBe("entra");
		expect(loginMethodKey("ldap")).toBe("unknown");
		expect(loginMethodKey(null)).toBe("unknown");
	});
});

describe("the members' sessions", () => {
	const session = (id: string, user: string, at: string): MemberSession => ({
		id,
		user_id: user,
		user_email: `${user}@x.io`,
		user_agent: null,
		created_at: at,
		expires_at: "2026-12-30T00:00:00Z",
		login_method: "local",
	});

	it("groups them by person, the latest sign-in first", () => {
		const people = byPerson([
			session("s1", "u2", "2026-11-20T10:00:00Z"),
			session("s2", "u3", "2026-11-26T10:00:00Z"),
			session("s3", "u2", "2026-11-27T10:00:00Z"),
		]);
		expect(people.map((p) => [p.userId, p.sessions.map((s) => s.id)])).toEqual([
			["u2", ["s3", "s1"]],
			["u3", ["s2"]],
		]);
	});

	it("keeps a device's description to a line", () => {
		expect(deviceOf(null)).toBeNull();
		expect(deviceOf("   ")).toBeNull();
		expect(deviceOf(" WorkPilot/1.6 ")).toBe("WorkPilot/1.6");
		const long = deviceOf("Mozilla/5.0 ".repeat(10)) ?? "";
		expect(long).toHaveLength(60);
		expect(long.endsWith("…")).toBe(true);
	});
});
