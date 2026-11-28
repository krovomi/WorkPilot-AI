import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Alert } from "react-native";
import type { AdminOverview, AuditEntry, MemberSession, Quota } from "../../admin/types";
import { confirmAlerts } from "../../../test-support/admin-fixtures";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

const QUOTA: Quota = {
	org_id: "org-a",
	max_users: 10,
	max_projects: null,
	max_concurrent_runs: 2,
	monthly_token_budget: 0,
	enforce_hard_stop: false,
	used_users: 3,
	used_projects: 4,
	used_concurrent_runs: 2,
	used_tokens_this_month: 1500,
};

const OVERVIEW: AdminOverview = {
	org_id: "org-a",
	org_name: "Acme",
	users_total: 5,
	users_active: 4,
	projects_total: 2,
	specs_total: 9,
	runs_active: 1,
	runs_queued: 3,
	runs_24h: 6,
	runs_failed_24h: 2,
	run_success_rate_7d: 0.756,
	quota: QUOTA,
	runs_by_day: [
		{ date: "2026-11-26", count: 0 },
		{ date: "2026-11-27", count: 4 },
	],
	runs_by_status: { succeeded: 3, failed: 2, paused: 1 },
	top_users: [{ user_id: "u2", display_name: "Bob", runs: 4 }],
	recent_failures: [
		{ run_id: "r1", phase: "qa", error: "Tests broke", finished_at: "2026-11-27T09:00:00Z" },
		{ run_id: "r2", phase: "build", error: "", finished_at: "2026-11-27T08:00:00Z" },
	],
};

describe("the administration home", () => {
	it("lists the console's pages the person may read", async () => {
		fakeServer({}, ["analytics.read", "org.session.read", "org.quota.read", "audit.read"]);
		const app = await openApp("/admin");
		expect(await screen.findByText("Overview")).toBeTruthy();
		for (const page of ["Sessions", "Quotas", "Audit log"]) expect(screen.getByText(page)).toBeTruthy();
		expect(screen.queryByText("Members")).toBeNull();
		await fireEvent.press(screen.getByText("Audit log"));
		await waitFor(() => expect(app.getPathname()).toBe("/admin/audit"));
	});

	it("is not offered in Settings for the overview alone", async () => {
		fakeServer({}, ["board.read", "analytics.read"]);
		await openApp("/settings");
		expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Administration" })).toBeNull();
	});
});

describe("the overview", () => {
	it("shows the agents now, the week, who started the most, the last failures and the quotas", async () => {
		fakeServer({ "GET /admin/overview": OVERVIEW }, ["analytics.read"]);
		await openApp("/admin/overview");
		expect(await screen.findByText("76 %")).toBeTruthy();
		expect(screen.getByText("4 active of 5")).toBeTruthy();
		expect(screen.getByText("Acme")).toBeTruthy();
		expect(screen.getByLabelText("2026-11-27: 4 runs")).toBeTruthy();
		// A status this version does not know keeps the server's word.
		expect(screen.getByText("Succeeded")).toBeTruthy();
		expect(screen.getByText("paused")).toBeTruthy();
		expect(screen.getByText("Bob")).toBeTruthy();
		expect(screen.getByText("4 runs")).toBeTruthy();
		expect(screen.getByText("Tests broke")).toBeTruthy();
		expect(screen.getByText(/^QA · /)).toBeTruthy();
		expect(screen.getByText("3 of 10")).toBeTruthy();
		expect(screen.getByText("4, no limit")).toBeTruthy();
		// A limit of 0 is full from the start.
		expect(screen.getByRole("progressbar", { name: "Tokens this month used" }).props["aria-valuenow"]).toBe(100);
		expect(screen.getByRole("progressbar", { name: "Seats used" }).props["aria-valuenow"]).toBe(30);
		expect(screen.queryByRole("progressbar", { name: "Projects used" })).toBeNull();
	});

	it("says when no agent ran this week, and leaves out the empty lists", async () => {
		fakeServer(
			{
				"GET /admin/overview": {
					...OVERVIEW,
					runs_failed_24h: 0,
					runs_by_day: [{ date: "2026-11-27", count: 0 }],
					runs_by_status: {},
					top_users: [],
					recent_failures: [],
				},
			},
			["analytics.read"],
		);
		await openApp("/admin/overview");
		expect(await screen.findByText("No run this week.")).toBeTruthy();
		expect(screen.queryByText("Who started the most runs")).toBeNull();
		expect(screen.queryByText("Last failures")).toBeNull();
	});

	it("says so when the server refuses", async () => {
		fakeServer({ "GET /admin/overview": reply(403, { detail: "no" }) }, ["analytics.read"]);
		await openApp("/admin/overview");
		expect(await screen.findByText(/don't have the rights/)).toBeTruthy();
	});
});

describe("the quotas", () => {
	it("changes only what was edited, lifts a limit left empty and says it is saved", async () => {
		let quota = QUOTA;
		const server = fakeServer(
			{
				"GET /admin/quotas": () => quota,
				"PUT /admin/quotas": (call: Call) => {
					quota = { ...quota, ...(call.body as Partial<Quota>) };
					return quota;
				},
			},
			["org.quota.read", "org.quota.write"],
		);
		await openApp("/admin/quotas");
		const seats = await screen.findByLabelText("Seats");
		expect(seats.props.value).toBe("10");
		expect(screen.getByLabelText("Projects").props.placeholder).toBe("No limit");
		const save = screen.getByRole("button", { name: "Save the limits" });
		expect(save).toBeDisabled();

		await fireEvent.changeText(seats, "abc");
		expect(screen.getByText("A limit is a whole number, 0 or more.")).toBeTruthy();
		expect(save).toBeDisabled();
		await fireEvent.changeText(seats, "25");
		await fireEvent.changeText(screen.getByLabelText("Agents at once"), "");
		await fireEvent(screen.getByLabelText("Stop the agents at the token budget"), "valueChange", true);
		await fireEvent.press(screen.getByRole("button", { name: "Save the limits" }));
		expect(await screen.findByText("Saved.")).toBeTruthy();
		expect(server.called("PUT /admin/quotas")[0].body).toEqual({
			max_users: 25,
			max_concurrent_runs: null,
			enforce_hard_stop: true,
		});
		expect(screen.getByLabelText("Seats").props.value).toBe("25");
		expect(screen.getByText("3 of 25")).toBeTruthy();
		// Editing again takes the confirmation away.
		await fireEvent.changeText(screen.getByLabelText("Seats"), "26");
		expect(screen.queryByText("Saved.")).toBeNull();
		await fireEvent(screen.getByLabelText("Stop the agents at the token budget"), "valueChange", false);
		expect(screen.getByRole("button", { name: "Save the limits" })).not.toBeDisabled();
	});

	it("shows a refused save, and keeps the draft", async () => {
		fakeServer(
			{ "GET /admin/quotas": QUOTA, "PUT /admin/quotas": reply(409, { detail: "Not now" }) },
			["org.quota.read", "org.quota.write"],
		);
		await openApp("/admin/quotas");
		await fireEvent.changeText(await screen.findByLabelText("Seats"), "30");
		await fireEvent.press(screen.getByRole("button", { name: "Save the limits" }));
		expect(await screen.findByText(/Not now/)).toBeTruthy();
		expect(screen.getByLabelText("Seats").props.value).toBe("30");
		expect(screen.queryByText("Saved.")).toBeNull();
	});

	it("reads the quotas without changing them for a reader", async () => {
		fakeServer({ "GET /admin/quotas": QUOTA }, ["org.quota.read"]);
		await openApp("/admin/quotas");
		expect((await screen.findByLabelText("Seats")).props.editable).toBe(false);
		expect(screen.getByLabelText("Stop the agents at the token budget").props.disabled).toBe(true);
		expect(screen.getByText("You can read the quotas, not change them.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Save the limits" })).toBeNull();
	});

	it("says so when the quotas cannot be read", async () => {
		fakeServer({ "GET /admin/quotas": reply(500, { detail: "down" }) }, ["org.quota.read"]);
		await openApp("/admin/quotas");
		expect(await screen.findByText(/down|went wrong/i)).toBeTruthy();
		expect(screen.queryByLabelText("Seats")).toBeNull();
	});
});

const line = (id: string, action: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
	id,
	user_id: "u1",
	user_email: "ada@x.io",
	project_id: null,
	action,
	payload: null,
	created_at: "2026-11-27T09:00:00Z",
	login_id: null,
	login_method: null,
	...extra,
});

describe("the audit log", () => {
	it("lists what was done, opens a line's details and filters by its action", async () => {
		const server = fakeServer(
			{
				"GET /admin/audit": (call: Call) =>
					call.query.get("action")
						? [line("a2", "org.quota.updated", { payload: { max_users: 25 } })]
						: [
								line("a1", "org.member.added", { login_id: "login-1", login_method: "entra" }),
								line("a2", "org.quota.updated", { payload: { max_users: 25 }, user_email: null, user_id: null }),
							],
			},
			["audit.read"],
		);
		await openApp("/admin/audit");
		expect(await screen.findByText("org.member.added")).toBeTruthy();
		expect(screen.getByText(/^ada@x\.io · .* · Microsoft Entra$/)).toBeTruthy();
		expect(screen.getByText(/^the server · /)).toBeTruthy();
		expect(server.called("GET /admin/audit")[0].query.get("limit")).toBe("50");

		await fireEvent.press(screen.getByRole("button", { name: /org\.quota\.updated/ }));
		expect(screen.getByText("max_users 25")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Only this action" }));
		expect(await screen.findByText("Only org.quota.updated")).toBeTruthy();
		await waitFor(() => expect(screen.queryByText("org.member.added")).toBeNull());
		expect(server.calls.at(-1)?.query.get("action")).toBe("org.quota.updated");
		// Open again, the line does not offer the filter it is already under.
		await fireEvent.press(screen.getByRole("button", { name: /org\.quota\.updated/ }));
		expect(screen.queryByRole("button", { name: "Only this action" })).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: /org\.quota\.updated/ }));
		expect(screen.queryByText("max_users 25")).toBeNull();

		await fireEvent.press(screen.getByRole("button", { name: "Show everything" }));
		expect(await screen.findByText("org.member.added")).toBeTruthy();
		expect(server.calls.at(-1)?.query.has("action")).toBe(false);
	});

	it("reads older lines a page at a time, up to what the server serves", async () => {
		const server = fakeServer(
			{
				"GET /admin/audit": (call: Call) =>
					Array.from({ length: Number(call.query.get("limit")) }, (_, i) =>
						line(`a${i}`, "auth.user.created", { login_id: "l", login_method: "ldap" }),
					),
			},
			["audit.read"],
		);
		await openApp("/admin/audit");
		expect((await screen.findAllByText("auth.user.created")).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/another sign-in$/).length).toBeGreaterThan(0);
		for (let page = 2; page <= 10; page++) {
			await fireEvent.press(screen.getByRole("button", { name: "Show older lines" }));
			await waitFor(() => expect(server.calls.at(-1)?.query.get("limit")).toBe(String(Math.min(page * 50, 500))));
		}
		await waitFor(() => expect(screen.queryByRole("button", { name: "Show older lines" })).toBeNull());
	});

	it("says when nothing is recorded", async () => {
		fakeServer({ "GET /admin/audit": [] }, ["audit.read"]);
		await openApp("/admin/audit");
		expect(await screen.findByText("Nothing recorded yet.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Show older lines" })).toBeNull();
	});
});

const session = (id: string, user: string, extra: Partial<MemberSession> = {}): MemberSession => ({
	id,
	user_id: user,
	user_email: `${user}@x.io`,
	user_agent: "WorkPilot/1.6 (iPhone)",
	created_at: "2026-11-27T08:00:00Z",
	expires_at: "2026-12-27T08:00:00Z",
	login_method: "local",
	...extra,
});

describe("the sessions", () => {
	it("lists each person's sign-ins and signs someone else out of every device", async () => {
		let sessions = [
			session("s1", "u1"),
			session("s2", "u2", { user_agent: null, login_method: "oidc" }),
			session("s3", "u2", { user_email: null, created_at: "2026-11-27T09:00:00Z" }),
		];
		const server = fakeServer(
			{
				"GET /admin/sessions": () => sessions,
				"DELETE /admin/sessions/u2": () => {
					sessions = sessions.filter((s) => s.user_id !== "u2");
					return { revoked: 2 };
				},
			},
			["org.session.read", "org.session.revoke"],
		);
		const alert = confirmAlerts();
		await openApp("/admin/sessions");
		// The person whose latest sign-in is the latest comes first, named by that sign-in.
		const bob = await screen.findByText("u2");
		expect(bob).toBeTruthy();
		expect(screen.getByText("u1@x.io (you)")).toBeTruthy();
		expect(screen.getAllByText(/^single sign-on · since /)).toHaveLength(1);
		expect(screen.getAllByText(/WorkPilot\/1\.6 \(iPhone\)$/)).toHaveLength(2);
		// No button to sign oneself out from here.
		expect(screen.getAllByRole("button", { name: "Sign out everywhere" })).toHaveLength(1);

		await fireEvent.press(screen.getByRole("button", { name: "Sign out everywhere" }));
		expect(alert).toHaveBeenCalledWith("Sign u2 out of every device?", expect.any(String), expect.any(Array));
		await waitFor(() => expect(screen.queryByText("u2")).toBeNull());
		expect(server.called("DELETE /admin/sessions/u2")).toHaveLength(1);
	});

	it("shows a refused sign-out, and reads without signing out for a reader", async () => {
		fakeServer(
			{
				"GET /admin/sessions": [session("s2", "u2")],
				"DELETE /admin/sessions/u2": reply(409, { detail: "Not now" }),
			},
			["org.session.read", "org.session.revoke"],
		);
		confirmAlerts();
		await openApp("/admin/sessions");
		await fireEvent.press(await screen.findByRole("button", { name: "Sign out everywhere" }));
		expect(await screen.findByText(/Not now/)).toBeTruthy();
		expect(screen.getByText("u2@x.io")).toBeTruthy();
	});

	it("offers no sign-out without the permission", async () => {
		fakeServer({ "GET /admin/sessions": [session("s2", "u2")] }, ["org.session.read"]);
		await openApp("/admin/sessions");
		expect(await screen.findByText("u2@x.io")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Sign out everywhere" })).toBeNull();
	});

	it("says so when the sessions cannot be read", async () => {
		fakeServer({ "GET /admin/sessions": reply(403, { detail: "no" }) }, ["org.session.read"]);
		await openApp("/admin/sessions");
		expect(await screen.findByText(/don't have the rights/)).toBeTruthy();
		expect(screen.queryByText("Nobody is signed in.")).toBeNull();
	});

	it("says when nobody is signed in", async () => {
		fakeServer({ "GET /admin/sessions": [] }, ["org.session.read"]);
		await openApp("/admin/sessions");
		expect(await screen.findByText("Nobody is signed in.")).toBeTruthy();
	});

	it("cancels a sign-out the person did not confirm", async () => {
		const server = fakeServer({ "GET /admin/sessions": [session("s2", "u2")] }, [
			"org.session.read",
			"org.session.revoke",
		]);
		jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
		await openApp("/admin/sessions");
		await fireEvent.press(await screen.findByRole("button", { name: "Sign out everywhere" }));
		expect(server.called("DELETE /admin/sessions/u2")).toHaveLength(0);
		expect(screen.getByText("u2@x.io")).toBeTruthy();
	});
});
