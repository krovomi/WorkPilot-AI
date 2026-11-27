import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { Alert } from "react-native";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const PROJECT = { id: "p1", name: "Shop", repo_url: "https://github.com/acme/shop", default_branch: "main" };

function board(extra: Record<string, unknown> = {}, me: Record<string, unknown> = {}) {
	return {
		scope: "project",
		period: "season",
		season: { start: "2026-10-01T00:00:00+00:00", end: "2027-01-01T00:00:00+00:00" },
		projects: 1,
		entries: [
			{ rank: 1, name: "Bob", delivered: 3, reviews: 1, points: 8, badges: ["first_delivery", "first_review"], you: false },
			{ rank: 1, name: "Ada Lovelace", delivered: 2, reviews: 2, points: 8, badges: ["unknown_badge"], you: true },
			{ rank: 4, name: "Eve", delivered: 1, reviews: 0, points: 1, badges: [], you: false },
		],
		me: { visible: true, delivered: 2, reviews: 2, points: 8, badges: ["first_delivery", "complex_delivery"], rank: 1, ...me },
		...extra,
	};
}

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("leaderboard", () => {
	it("is a row of the More tab for whoever reads the analytics", async () => {
		fakeServer({ "GET /projects/p1": PROJECT, "GET /api/features/pixel-office/leaderboard": board() }, ["analytics.read"]);
		await openApp("/projects/p1/more");
		await fireEvent.press(await screen.findByRole("button", { name: "Leaderboard" }));
		expect(await screen.findByText("Your score")).toBeTruthy();
	});

	it("shows the person's score and badges, the people named, and reads another scope and period", async () => {
		const server = fakeServer(
			{ "GET /projects/p1": PROJECT, "GET /api/features/pixel-office/leaderboard": board() },
			["analytics.read"],
		);
		await openApp("/projects/p1/leaderboard");
		expect(await screen.findByText("8 points")).toBeTruthy();
		expect(screen.getByText(/Season from/)).toBeTruthy();
		expect(screen.getByText(/2 delivered · 2 reviews · rank 1/)).toBeTruthy();
		expect(screen.getByText("Complex card delivered")).toBeTruthy();
		expect(screen.getByLabelText("Rank 1, Bob, 8 points")).toBeTruthy();
		expect(screen.getByText("Ada Lovelace (you)")).toBeTruthy();
		expect(screen.getByLabelText("Rank 4, Eve, 1 point")).toBeTruthy();
		expect(within(screen.getByLabelText("Rank 1, Bob, 8 points")).getByText("First review")).toBeTruthy();
		expect(server.called("GET /api/features/pixel-office/leaderboard")[0].query.get("scope")).toBe("project");

		server.routes["GET /api/features/pixel-office/leaderboard"] = board({ scope: "org", period: "all" });
		await fireEvent.press(screen.getByRole("radio", { name: "Whole organization" }));
		await fireEvent.press(screen.getByRole("radio", { name: "Since the start" }));
		await waitFor(() => expect(screen.queryByText(/Season from/)).toBeNull());
		const last = server.called("GET /api/features/pixel-office/leaderboard").at(-1);
		expect(last?.query.get("scope")).toBe("org");
		expect(last?.query.get("period")).toBe("all");
		expect(last?.query.get("project_id")).toBe("p1");
	});

	it("names nobody until they agree, and saves the person's own choice", async () => {
		let visible = false;
		const server = fakeServer(
			{
				"GET /projects/p1": PROJECT,
				"GET /api/features/pixel-office/leaderboard": () =>
					board({ entries: [] }, { visible, rank: null, points: 0, delivered: 0, reviews: 0, badges: [] }),
				"PUT /api/features/pixel-office/consent": (call: Call) => {
					visible = (call.body as { visible: boolean }).visible;
					return { visible };
				},
			},
			["analytics.read"],
		);
		await openApp("/projects/p1/leaderboard");
		expect(await screen.findByText("Nobody is named yet.")).toBeTruthy();
		expect(screen.getByText(/not ranked/)).toBeTruthy();
		const toggle = screen.getByLabelText("Show my name on the leaderboard");
		expect(toggle.props.value).toBe(false);
		await fireEvent(toggle, "valueChange", true);
		await waitFor(() => expect(screen.getByLabelText("Show my name on the leaderboard").props.value).toBe(true));
		expect(server.called("PUT /api/features/pixel-office/consent")[0].body).toEqual({ visible: true });
		expect(server.called("PUT /api/features/pixel-office/consent")[0].query.get("project_id")).toBe("p1");
	});

	it("says why the choice was not saved, and why the board did not load", async () => {
		const server = fakeServer(
			{
				"GET /projects/p1": PROJECT,
				"GET /api/features/pixel-office/leaderboard": board(),
				"PUT /api/features/pixel-office/consent": reply(409, { detail: "Not now" }),
			},
			["analytics.read"],
		);
		await openApp("/projects/p1/leaderboard");
		await fireEvent(await screen.findByLabelText("Show my name on the leaderboard"), "valueChange", false);
		expect(await screen.findByText(/Not now/)).toBeTruthy();

		server.routes["GET /api/features/pixel-office/leaderboard"] = reply(409, { detail: "Board offline" });
		await fireEvent.press(screen.getByRole("radio", { name: "Whole organization" }));
		expect(await screen.findByText(/Board offline/)).toBeTruthy();
	});
});

describe("leaderboard that does not load", () => {
	it("says why, with nothing else to show", async () => {
		fakeServer(
			{ "GET /projects/p1": PROJECT, "GET /api/features/pixel-office/leaderboard": reply(409, { detail: "No scores" }) },
			["analytics.read"],
		);
		await openApp("/projects/p1/leaderboard");
		expect(await screen.findByText(/No scores/)).toBeTruthy();
		expect(screen.queryByText("Your score")).toBeNull();
	});
});

const SHARES = [
	{
		id: "s1",
		title: "Login flow",
		steps: 12,
		size_bytes: 2048,
		created_at: "2026-11-20T10:00:00Z",
		expires_at: "2026-12-20T10:00:00Z",
		state: "active",
		open_count: 3,
		last_opened_at: "2026-11-26T10:00:00Z",
		can_revoke: true,
		project_id: "p1",
		project_name: "Shop",
	},
	{
		id: "s2",
		title: "Cart bug",
		steps: 1,
		size_bytes: 512,
		created_at: "2026-10-01T10:00:00Z",
		expires_at: "2026-10-08T10:00:00Z",
		state: "expired",
		open_count: 1,
		last_opened_at: "2026-10-02T10:00:00Z",
		can_revoke: true,
		project_id: "p2",
		project_name: "Docs",
	},
	{
		id: "s3",
		title: "Ended one",
		steps: 4,
		size_bytes: 10,
		created_at: null,
		expires_at: null,
		state: "revoked",
		open_count: 0,
		last_opened_at: null,
		can_revoke: true,
		project_id: "p1",
		project_name: "Shop",
	},
	{
		id: "s4",
		title: "Forever",
		steps: 2,
		size_bytes: 10,
		created_at: null,
		expires_at: null,
		state: "active",
		open_count: 0,
		last_opened_at: null,
		can_revoke: false,
		project_id: "p1",
		project_name: "Shop",
	},
];

function share(title: string) {
	let node = screen.getByText(title);
	while (node.parent && !within(node.parent).queryAllByText(/·/).length) node = node.parent;
	return within(node.parent ?? node);
}

const TOKENS = "My tokens on the server";

describe("my replay links", () => {
	it("is a row of Settings for whoever reads the lab, and only for them", async () => {
		fakeServer({ "GET /api/features/replay-shares/mine": { shares: [] } }, ["lab.read"]);
		await openApp("/settings");
		await fireEvent.press(await screen.findByRole("button", { name: "My replay links" }));
		expect(await screen.findByText("You have shared no replay.")).toBeTruthy();
	});

	it("is not offered without the lab", async () => {
		fakeServer({});
		await openApp("/settings");
		await screen.findByRole("button", { name: TOKENS });
		expect(screen.queryByRole("button", { name: "My replay links" })).toBeNull();
	});

	it("lists each link with its state and how often it was opened, and ends one", async () => {
		let shares = SHARES;
		const server = fakeServer(
			{
				"GET /api/features/replay-shares/mine": () => ({ shares }),
				"DELETE /api/features/replay-shares/s1": () => {
					shares = [{ ...SHARES[0], state: "revoked" }, ...SHARES.slice(1)];
					return { revoked: true };
				},
			},
			["lab.read"],
		);
		jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => void buttons?.[1].onPress?.());
		await openApp("/replays");
		expect(await screen.findByText("Login flow")).toBeTruthy();
		expect(share("Login flow").getByText("Shop · 12 steps")).toBeTruthy();
		expect(share("Login flow").getByText(/Opened 3 times, last/)).toBeTruthy();
		expect(share("Login flow").getByText(/Opens until/)).toBeTruthy();
		expect(share("Cart bug").getByText("Expired")).toBeTruthy();
		expect(share("Cart bug").getByText("Docs · 1 step")).toBeTruthy();
		expect(share("Cart bug").getByText(/Opened once/)).toBeTruthy();
		expect(share("Cart bug").queryByRole("button", { name: "End the link" })).toBeNull();
		expect(share("Ended one").getByText("Ended")).toBeTruthy();
		expect(share("Ended one").getByText("Not opened yet")).toBeTruthy();
		expect(share("Forever").getByText("Open")).toBeTruthy();
		expect(share("Forever").queryByText(/Opens until/)).toBeNull();
		expect(share("Forever").queryByRole("button", { name: "End the link" })).toBeNull();

		await fireEvent.press(share("Login flow").getByRole("button", { name: "End the link" }));
		await waitFor(() => expect(screen.queryAllByRole("button", { name: "End the link" })).toHaveLength(0));
		expect(server.called("DELETE /api/features/replay-shares/s1")[0].query.get("project_id")).toBe("p1");
	});

	it("says why a link was not ended", async () => {
		const server = fakeServer(
			{
				"GET /api/features/replay-shares/mine": { shares: SHARES.slice(0, 1) },
				"DELETE /api/features/replay-shares/s1": reply(409, { detail: "Already gone" }),
			},
			["lab.read"],
		);
		jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => void buttons?.[1].onPress?.());
		await openApp("/replays");
		await fireEvent.press(await screen.findByRole("button", { name: "End the link" }));
		expect(await screen.findByText(/Already gone/)).toBeTruthy();
		expect(server.called("DELETE /api/features/replay-shares/s1")).toHaveLength(1);
	});

	it("says why the list did not load", async () => {
		fakeServer({ "GET /api/features/replay-shares/mine": reply(409, { detail: "Lab offline" }) }, ["lab.read"]);
		await openApp("/replays");
		expect(await screen.findByText(/Lab offline/)).toBeTruthy();
	});
});
