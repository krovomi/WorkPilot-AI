import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { AppState } from "react-native";
import type { BoardCard } from "../../api/types";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

function card(id: string, title: string, extra: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title,
		column: "backlog",
		kind: null,
		updatedAt: null,
		subtasks: { completed: 0, total: 0 },
		specId: `spec-${id}`,
		claimedBy: null,
		claimedByName: null,
		...extra,
	};
}

const CARDS = [
	card("001-login", "Login page", { kind: "feature" }),
	card("002-api", "Fix the API", { column: "in_progress", subtasks: { completed: 1, total: 4 }, claimedByName: "Bob" }),
	card("003-oauth-a", "OAuth part 1", {
		column: "in_progress",
		group: { id: "grp-oauth", title: "OAuth", index: 1, total: 2 },
	}),
	card("004-oauth-b", "OAuth part 2", {
		column: "human_review",
		group: { id: "grp-oauth", title: "OAuth", index: 2, total: 2 },
	}),
];

const PROJECT = { id: "p1", name: "Shop", repo_url: "https://github.com/acme/shop", default_branch: "main", forge: "github" };

beforeEach(() => {
	// The app is in the foreground, as on a phone that just opened it.
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
	restoreFetch();
});

describe("board", () => {
	it("opens on what waits for a person, and shows the cards' progress, claim and kind", async () => {
		fakeServer({ "GET /api/board/cards": { cards: CARDS }, "GET /projects/p1": PROJECT });
		await openApp("/projects/p1?name=Shop");
		expect(await screen.findByText("OAuth part 2")).toBeTruthy();
		expect(screen.queryByText("Fix the API")).toBeNull();
		await fireEvent.press(screen.getByRole("tab", { name: /In Progress/ }));
		expect(await screen.findByText("Fix the API")).toBeTruthy();
		expect(screen.getByText("1/4 subtasks")).toBeTruthy();
		expect(screen.getByText("Claimed by Bob")).toBeTruthy();
		// The stream is down in this test: the board polls.
		expect(screen.getByText("Refreshing every few seconds")).toBeTruthy();
		// Planning's card is behind its tab.
		expect(screen.queryByText("Login page")).toBeNull();
		await fireEvent.press(screen.getByRole("tab", { name: /Planning/ }));
		expect(await screen.findByText("Login page")).toBeTruthy();
		expect(screen.getByText("Feature")).toBeTruthy();
		// A column only shown with a card.
		expect(screen.queryByRole("tab", { name: /Red Build/ })).toBeNull();
	});

	it("shows only a split group's cards from a tap on its mark, then every card again", async () => {
		fakeServer({ "GET /api/board/cards": { cards: CARDS }, "GET /projects/p1": PROJECT });
		await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("tab", { name: /In Progress/ }));
		await fireEvent.press(await screen.findByRole("button", { name: "Part 1/2 · OAuth" }));
		expect(await screen.findByText("Group grp-oauth · show all")).toBeTruthy();
		expect(screen.queryByText("Fix the API")).toBeNull();
		const review = screen.getByRole("tab", { name: /Human Review/ });
		expect(within(review).getByText("1")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Show every card" }));
		expect(await screen.findByText("Fix the API")).toBeTruthy();

		// The same mark tapped twice also clears the filter.
		await fireEvent.press(screen.getByRole("button", { name: "Part 1/2 · OAuth" }));
		await fireEvent.press(screen.getByRole("button", { name: "Part 1/2 · OAuth" }));
		expect(await screen.findByText("Fix the API")).toBeTruthy();
	});

	it("offers the project's pages the person may read, and opens a card", async () => {
		fakeServer(
			{
				"GET /api/board/cards": { cards: CARDS },
				"GET /projects/p1": PROJECT,
				"GET /api/board/cards/002-api": { ...CARDS[1], description: "", spec: null, approval: {}, requireReview: true },
			},
			["board.read", "insight.read", "vcs.read", "analytics.read"],
		);
		const app = await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("tab", { name: /In Progress/ }));
		await screen.findByText("Fix the API");
		const links = screen.getAllByRole("link").map((l) => within(l).getByText(/./).props.children);
		expect(links).toEqual(["Insights", "Roadmap", "Ideas", "Context", "GitHub", "Dashboard"]);
		await fireEvent.press(screen.getByRole("button", { name: "Fix the API" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/002-api"));
	});

	it("hides the forge link for a project without a known forge, and opens the roadmap", async () => {
		fakeServer(
			{
				"GET /api/board/cards": { cards: [] },
				"GET /projects/p1": { ...PROJECT, forge: null },
				"GET /api/features/roadmap/snapshot": { files: {}, job: null },
			},
			["board.read", "insight.read", "vcs.read"],
		);
		const app = await openApp("/projects/p1");
		expect(await screen.findAllByText("No card here.")).toBeTruthy();
		expect(screen.queryByText("GitHub")).toBeNull();
		await fireEvent.press(screen.getByText("Roadmap"));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/roadmap"));
	});

	it("opens New card only for someone who may write tasks", async () => {
		fakeServer(
			{ "GET /api/board/cards": { cards: [] }, "GET /projects/p1": PROJECT, "GET /api/board/engines": { engines: [] } },
			["board.read", "task.write"],
		);
		const app = await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("button", { name: "New card" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/new"));
	});

	it("has no New card without task.write, and shows a board that cannot be read", async () => {
		fakeServer({ "GET /api/board/cards": reply(500, { detail: "index broken" }), "GET /projects/p1": PROJECT });
		await openApp("/projects/p1");
		expect(await screen.findByText(/index broken/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "New card" })).toBeNull();
	});
});
