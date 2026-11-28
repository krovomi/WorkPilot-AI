import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { AppState } from "react-native";
import type { BoardCard, CardApproval, CardDetails, Delegation } from "../../api/types";
import { saveLockSettings } from "../../auth/lock";
import { USER, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const CARD_PATH = "/api/board/cards/007-search";
const RUNS_PATH = "/projects/p1/specs/spec-7/runs";
const DELEGATIONS = "/api/board/delegations";

const CARD: BoardCard = {
	id: "007-search",
	title: "Search the catalogue",
	column: "backlog",
	kind: "feature",
	updatedAt: null,
	subtasks: { completed: 0, total: 0 },
	specId: "spec-7",
	claimedBy: null,
	claimedByName: null,
};

const DETAILS = {
	...CARD,
	description: "",
	spec: "# Plan",
	approval: { approved: false, approvedBy: null, approvedAt: null },
	requireReview: true,
} as CardDetails;

function approval(extra: Partial<CardApproval> = {}): CardApproval {
	return {
		criticality: "medium",
		criticalitySource: "assessed",
		needed: 2,
		count: 1,
		roles: [],
		missingRoles: [],
		approvals: [{ by: "Bob", for: null, at: "2026-11-20T09:00:00Z", roles: [] }],
		complete: false,
		approved: false,
		...extra,
	};
}

function serveCard(routes: Record<string, unknown>, permissions = ["board.read", "agent.execute", "review.approve"]) {
	return fakeServer(
		{
			"GET /api/board/cards": { cards: [CARD] },
			[`GET ${CARD_PATH}`]: DETAILS,
			[`GET ${RUNS_PATH}`]: [],
			[`GET ${CARD_PATH}/changes`]: reply(404, { detail: "no worktree" }),
			[`GET ${CARD_PATH}/logs`]: { logs: null },
			[`GET ${CARD_PATH}/steering`]: { messages: [] },
			...routes,
		},
		permissions,
	);
}

beforeEach(async () => {
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
	await saveLockSettings({ atLaunch: false, sensitive: false });
});

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("a card's approval", () => {
	it("shows the count, who approved and what is missing, and changes the criticality", async () => {
		const server = serveCard({
			[`GET ${CARD_PATH}/approvals`]: approval({
				missingRoles: ["security"],
				approvals: [
					{ by: "Bob", for: null, at: "2026-11-20T09:00:00Z", roles: [] },
					{ by: "Eve", for: "Carl", at: "2026-11-20T10:00:00Z", roles: [] },
				],
			}),
			[`PUT ${CARD_PATH}/criticality`]: approval({ criticality: "low", criticalitySource: "set", needed: 1, approved: true }),
		});
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("1 of 2 approvals")).toBeTruthy();
		expect(screen.getByText("Assessed from the plan")).toBeTruthy();
		expect(screen.getByText("Still missing: security")).toBeTruthy();
		expect(screen.getByText(/^Bob, /)).toBeTruthy();
		expect(screen.getByText(/^Eve for Carl, /)).toBeTruthy();
		// The level already chosen sends nothing.
		await fireEvent.press(screen.getByRole("radio", { name: "Medium" }));
		expect(server.called(`PUT ${CARD_PATH}/criticality`)).toEqual([]);
		await fireEvent.press(screen.getByRole("radio", { name: "Low" }));
		expect(await screen.findByText("1 of 1 approvals")).toBeTruthy();
		expect(screen.getByText("Set by a person")).toBeTruthy();
		expect(screen.queryByText(/Still missing/)).toBeNull();
		expect(server.called(`PUT ${CARD_PATH}/criticality`).map((c) => c.body)).toEqual([{ criticality: "low" }]);
	});

	it("says why the server refused a criticality", async () => {
		serveCard({
			[`GET ${CARD_PATH}/approvals`]: approval(),
			[`PUT ${CARD_PATH}/criticality`]: reply(403, { detail: "Missing permission" }),
		});
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("radio", { name: "High" }));
		expect(await screen.findByText("You don't have the rights for this action.")).toBeTruthy();
		expect(screen.getByText("1 of 2 approvals")).toBeTruthy();
	});

	it("offers the levels only to a person who may approve", async () => {
		serveCard({ [`GET ${CARD_PATH}/approvals`]: approval() }, ["board.read"]);
		await openApp("/projects/p1/cards/007-search");
		const high = await screen.findByRole("radio", { name: "High" });
		expect(high.props.accessibilityState).toMatchObject({ disabled: true });
	});

	it("approves without building while the card waits for a second approver, then reads it again", async () => {
		let reads = 0;
		const server = serveCard({
			[`GET ${CARD_PATH}/approvals`]: () => {
				reads += 1;
				return approval({ count: reads > 1 ? 1 : 0, approvals: [] });
			},
			[`POST ${CARD_PATH}/approve`]: { approved: false, approvedBy: null, approval: { count: 1, needed: 2 } },
		});
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("0 of 2 approvals")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Start" }));
		expect(
			await screen.findByText(
				"Your approval is recorded: 1 of 2. The build starts once the card has every approval it needs.",
			),
		).toBeTruthy();
		expect(await screen.findByText("1 of 2 approvals")).toBeTruthy();
		expect(server.called(`POST ${RUNS_PATH}`)).toEqual([]);
	});
});

function delegation(extra: Partial<Delegation> = {}): Delegation {
	return {
		id: "d1",
		from: { id: "u3", name: "Bob" },
		to: { id: "u1", name: "Ada" },
		startsAt: "2026-11-20T00:00:00Z",
		endsAt: "2026-11-30T00:00:00Z",
		active: true,
		...extra,
	};
}

const MEMBERS = [
	{ user_id: USER.id, email: USER.email, display_name: USER.display_name, role: "owner" },
	{ user_id: "u2", email: "carl@x.io", display_name: "", role: "member" },
	{ user_id: "u3", email: "bob@x.io", display_name: "Bob", role: "owner" },
	{ user_id: "u4", email: "vic@x.io", display_name: "Vic", role: "viewer" },
];

describe("lent approvals", () => {
	it("is offered on the board to a person who may approve", async () => {
		fakeServer(
			{
				"GET /api/board/cards": { cards: [] },
				"GET /projects/p1": { id: "p1", name: "Shop", forge: null },
				[`GET ${DELEGATIONS}`]: [],
				"GET /projects/p1/members": MEMBERS,
			},
			["board.read", "review.approve"],
		);
		const app = await openApp("/projects/p1/more");
		await fireEvent.press(await screen.findByRole("button", { name: "Lent approvals" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/delegations"));
	});

	it("lists them, ends one, and lends one's own to a colleague for some days", async () => {
		let lent: Delegation[] = [delegation(), delegation({ id: "d2", active: false, to: { id: "u2", name: "Carl" } })];
		const server = fakeServer(
			{
				[`GET ${DELEGATIONS}`]: () => lent,
				"GET /projects/p1/members": MEMBERS,
				[`DELETE ${DELEGATIONS}/d1`]: () => {
					lent = lent.filter((d) => d.id !== "d1");
					return { revoked: true };
				},
				[`POST ${DELEGATIONS}`]: () => {
					lent = [...lent, delegation({ id: "d3", from: { id: "u1", name: "Ada" }, to: { id: "u3", name: "Bob" } })];
					return lent[lent.length - 1];
				},
			},
			["board.read", "review.approve"],
		);
		await openApp("/projects/p1/delegations");
		expect(await screen.findByText(/^Bob → Ada, /)).toBeTruthy();
		expect(screen.getByText(/^Bob → Carl, /)).toBeTruthy();
		expect(screen.getByText("Active")).toBeTruthy();
		expect(screen.getByText("Planned")).toBeTruthy();
		// Only the project's other writers are offered, by name or else email.
		expect(screen.getAllByRole("radio").map((r) => within(r).getByText(/./).props.children)).toEqual([
			"carl@x.io",
			"Bob",
		]);
		await fireEvent.press(screen.getAllByRole("button", { name: "End" })[0]);
		await waitFor(() => expect(screen.queryByText(/^Bob → Ada, /)).toBeNull());

		const lend = screen.getByRole("button", { name: "Lend" });
		expect(lend.props.accessibilityState).toMatchObject({ disabled: true });
		await fireEvent.press(screen.getByRole("radio", { name: "Bob" }));
		await fireEvent.changeText(screen.getByLabelText("For how many days (1 to 90)"), "120");
		expect(screen.getByRole("button", { name: "Lend" }).props.accessibilityState).toMatchObject({ disabled: true });
		await fireEvent.press(screen.getByRole("button", { name: "Lend" }));
		await fireEvent.changeText(screen.getByLabelText("For how many days (1 to 90)"), "3");
		const before = Date.now();
		await fireEvent.press(screen.getByRole("button", { name: "Lend" }));
		expect(await screen.findByText(/^Ada → Bob, /)).toBeTruthy();
		const [sent] = server.called(`POST ${DELEGATIONS}`).map((c) => c.body as { to_user_id: string; ends_at: string });
		expect(sent.to_user_id).toBe("u3");
		expect(Date.parse(sent.ends_at) - before).toBeGreaterThanOrEqual(3 * 24 * 3600 * 1000);
		expect(screen.getByRole("radio", { name: "Bob" }).props.accessibilityState).toMatchObject({ selected: false });
	});

	it("says so when nothing is lent and no colleague can approve, and shows refusals", async () => {
		fakeServer(
			{
				[`GET ${DELEGATIONS}`]: [],
				"GET /projects/p1/members": [MEMBERS[0], MEMBERS[3]],
			},
			["board.read", "review.approve"],
		);
		await openApp("/projects/p1/delegations");
		expect(await screen.findByText("No approval is lent on this project.")).toBeTruthy();
		expect(screen.getByText("No colleague can approve on this project.")).toBeTruthy();
	});

	it("keeps the choice when the server refuses the lending", async () => {
		fakeServer(
			{
				[`GET ${DELEGATIONS}`]: [],
				"GET /projects/p1/members": MEMBERS,
				[`POST ${DELEGATIONS}`]: reply(409, { detail: "Overlaps" }),
			},
			["board.read", "review.approve"],
		);
		await openApp("/projects/p1/delegations");
		await fireEvent.press(await screen.findByRole("radio", { name: "Bob" }));
		await fireEvent.press(screen.getByRole("button", { name: "Lend" }));
		expect(await screen.findByText("Something went wrong: Overlaps")).toBeTruthy();
		expect(screen.getByRole("radio", { name: "Bob" }).props.accessibilityState).toMatchObject({ selected: true });
	});

	it("shows why the list could not be read", async () => {
		fakeServer({ "GET /projects/p1/members": MEMBERS }, ["board.read", "review.approve"]);
		await openApp("/projects/p1/delegations");
		expect(await screen.findByText("Something went wrong: not found")).toBeTruthy();
		expect(screen.getByText("No colleague can approve on this project.")).toBeTruthy();
	});
});
