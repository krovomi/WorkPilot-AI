import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Share } from "react-native";
import { periodOf } from "../../usage/period";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

jest.mock("expo-sharing", () => ({ getSharedPayloads: jest.fn(() => []), clearSharedPayloads: jest.fn() }));

const ended = (total: number, succeeded: number) => ({ total, succeeded, failed: 0, cancelled: 0, success_rate: null });
const MINE = {
	user: { user_id: "u1", name: "Ada", email: "ada@x.io" },
	summary: {
		start: "2026-10-29",
		end: "2026-11-27",
		tokens: { input: 1000, output: 234, total: 1234 },
		cost_usd: 2.5,
		sessions: 2,
		estimated: true,
		runs: ended(3, 2),
		jobs: ended(1, 1),
	},
	daily: [
		{ day: "2026-11-26", provider: "anthropic", tokens: 1000, cost_usd: 2 },
		{ day: "2026-11-27", provider: "anthropic", tokens: 200, cost_usd: 0.4 },
		{ day: "2026-11-27", provider: "openai", tokens: 34, cost_usd: 0.1 },
	],
	timeline: [
		{ at: "2026-11-27T08:00:00Z", kind: "sign_in", what: "auth.login.local" },
		{ at: "2026-11-27T07:00:00Z", kind: "run", what: "coding", status: "succeeded" },
	],
	pages: { enabled: true, pages: [{ client: "mobile", page: "home", opens: 3 }] },
	visible_to: ["Administrator", "Owner"],
};
const NOTICE = {
	due: true,
	measured: ["tokens", "runs", "jobs", "sign_ins", "presence"],
	page_activity: true,
	usage_retention_days: 365,
	page_activity_retention_days: 183,
	visible_to: ["Administrator", "Owner"],
};

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("my usage", () => {
	it("shows what administrators see, from Settings", async () => {
		const server = fakeServer({ "GET /users/me/usage": MINE, "GET /projects": [] });
		const app = await openApp("/settings");
		await fireEvent.press(await screen.findByRole("button", { name: "My usage" }));
		await waitFor(() => expect(app.getPathname()).toBe("/my-usage"));
		expect(await screen.findByText("1,234 tokens")).toBeTruthy();
		expect(screen.getByText("Readable by: Administrator, Owner, and the server's platform administrators.")).toBeTruthy();
		expect(screen.getByText("Cost: $2.50 (partly estimated)")).toBeTruthy();
		expect(screen.getByText("Runs: 3, 2 succeeded")).toBeTruthy();
		expect(screen.getByText("234")).toBeTruthy();
		expect(screen.getByText("11/27/2026")).toBeTruthy();
		expect(screen.getByText("Sign-in: auth.login.local")).toBeTruthy();
		expect(screen.getByText("Run: coding · succeeded")).toBeTruthy();
		expect(screen.getByText("home")).toBeTruthy();
		const [call] = server.called("GET /users/me/usage");
		expect(call.query.get("start")).toBe(periodOf(30).start);
	});

	it("says when the period holds nothing", async () => {
		fakeServer({
			"GET /users/me/usage": {
				...MINE,
				summary: { ...MINE.summary, estimated: false, cost_usd: 0, tokens: { input: 1, output: 0, total: 1 } },
				daily: [],
				timeline: [],
				pages: { enabled: false, pages: [] },
			},
		});
		await openApp("/my-usage");
		expect(await screen.findByText("1 token")).toBeTruthy();
		expect(screen.getByText("Cost: $0.00")).toBeTruthy();
		expect(screen.getAllByText("Nothing in this period.")).toHaveLength(2);
		expect(screen.queryByText("Pages opened")).toBeNull();
	});

	it("shares everything kept, or says why not", async () => {
		const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction", activityType: undefined });
		const exports = [{ account: { id: "u1" } }, reply(404, { detail: "Account not found" })];
		fakeServer({ "GET /users/me/usage": MINE, "GET /users/me/usage/export": () => exports.shift() });
		await openApp("/my-usage");
		const button = await screen.findByRole("button", { name: "Share everything kept about me (JSON)" });
		await fireEvent.press(button);
		await waitFor(() => expect(share).toHaveBeenCalled());
		expect(JSON.parse(share.mock.calls[0][0].message as string)).toEqual({ account: { id: "u1" } });
		await fireEvent.press(button);
		expect(await screen.findByText(/Account not found/)).toBeTruthy();
	});

	it("shows the notice again and closes it", async () => {
		const notices = [reply(500, { detail: "down" }), { ...NOTICE, due: false }];
		fakeServer({ "GET /users/me/usage": reply(500, { detail: "database down" }), "GET /users/me/usage-notice": () => notices.shift() });
		await openApp("/my-usage");
		expect(await screen.findByText(/database down/)).toBeTruthy();
		const button = screen.getByRole("button", { name: "Read again what is measured" });
		await fireEvent.press(button);
		expect(await screen.findByText("Screen counts are kept 183 days.")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "I understand" }));
		await waitFor(() => expect(screen.queryByText("Screen counts are kept 183 days.")).toBeNull());
	});
});

describe("the notice of what is measured", () => {
	it("shows once when due, and records that it was read", async () => {
		const server = fakeServer({
			"GET /projects": [],
			"GET /users/me/usage-notice": { ...NOTICE, page_activity: false },
			"POST /users/me/usage-notice": { ...NOTICE, due: false },
		});
		await openApp("/");
		expect(await screen.findByText("What this server measures about you")).toBeTruthy();
		expect(screen.getByText("• The days you were connected, and when you were last seen")).toBeTruthy();
		expect(screen.queryByText(/Screen counts are kept/)).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: "I understand" }));
		await waitFor(() => expect(server.called("POST /users/me/usage-notice")).toHaveLength(1));
		expect(screen.queryByText("What this server measures about you")).toBeNull();
	});

	it("stays away when read already, and a failed record is not shown", async () => {
		fakeServer({ "GET /projects": [], "GET /users/me/usage-notice": { ...NOTICE, due: false } });
		await openApp("/");
		expect(await screen.findByText("No project yet. Add one from the desktop app.")).toBeTruthy();
		expect(screen.queryByText("What this server measures about you")).toBeNull();
	});

	it("survives a refused record", async () => {
		const server = fakeServer({
			"GET /projects": [],
			"GET /users/me/usage-notice": NOTICE,
			"POST /users/me/usage-notice": reply(500, { detail: "down" }),
		});
		await openApp("/");
		await fireEvent.press(await screen.findByRole("button", { name: "I understand" }));
		await waitFor(() => expect(server.called("POST /users/me/usage-notice")).toHaveLength(1));
		expect(screen.queryByText("What this server measures about you")).toBeNull();
	});
});
