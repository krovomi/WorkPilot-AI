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

/** A button of the project's tab bar (a tab on Android, a button on iOS, as Jest runs). */
function tabButton(name: string) {
	return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

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
		expect(screen.getByLabelText("Refreshing every few seconds")).toBeTruthy();
		expect(screen.getByText("Sync")).toBeTruthy();
		// Planning's card is behind its tab.
		expect(screen.queryByText("Login page")).toBeNull();
		await fireEvent.press(screen.getByRole("tab", { name: /Planning/ }));
		expect(await screen.findByText("Login page")).toBeTruthy();
		expect(screen.getByText("Feature")).toBeTruthy();
		// A column only shown with a card.
		expect(screen.queryByRole("tab", { name: /Red Build/ })).toBeNull();
	});

	it("marks a flagged card, and draws a card set aside in Abandoned", async () => {
		const cards = [
			card("001-blocked", "Payment form", { column: "in_progress", flagged: true }),
			card("002-aside", "Old banner", { column: "backlog", outcome: "abandoned" }),
		];
		fakeServer({ "GET /api/board/cards": { cards }, "GET /projects/p1": PROJECT });
		await openApp("/projects/p1");
		expect(await screen.findByText("Payment form")).toBeTruthy();
		expect(screen.getByText("Blocked")).toBeTruthy();
		await fireEvent.press(screen.getByRole("tab", { name: /Abandoned/ }));
		expect(await screen.findByText("Old banner")).toBeTruthy();
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

	it("offers the project's pages the person may read as tabs and rows of More, and opens a card", async () => {
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
		for (const tab of ["Board", "Insights", "GitHub", "Dashboard", "More"]) {
			expect(tabButton(tab)).toBeTruthy();
		}
		await fireEvent.press(screen.getByRole("button", { name: "Fix the API" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/002-api"));
	});

	it("lists the other pages under More with what each is for, and hides those a role would refuse", async () => {
		fakeServer(
			{ "GET /api/board/cards": { cards: CARDS }, "GET /projects/p1": PROJECT },
			["board.read", "insight.read", "analytics.read"],
		);
		await openApp("/projects/p1/more");
		const rows = (await screen.findAllByRole("button")).map((b) => b.props.accessibilityLabel).filter(Boolean);
		expect(rows).toEqual(expect.arrayContaining(["Roadmap", "Ideas", "Context", "Sessions", "Analyses"]));
		expect(rows).not.toContain("Governance");
		expect(screen.getByText("Every agent session of the project, with its tokens and cost")).toBeTruthy();
	});

	it("says More has nothing for a role that opens no other page", async () => {
		fakeServer({ "GET /api/board/cards": { cards: [] }, "GET /projects/p1": PROJECT }, ["board.read"]);
		await openApp("/projects/p1/more");
		expect(await screen.findByText("Your role opens no other page of this project.")).toBeTruthy();
	});

	it("says how long ago a card moved", async () => {
		const moved = new Date(Date.now() - 5 * 60_000).toISOString();
		fakeServer({
			"GET /api/board/cards": { cards: [card("006-x", "Tidy up", { kind: "docs", updatedAt: moved })] },
			"GET /projects/p1": PROJECT,
		});
		await openApp("/projects/p1");
		expect(await screen.findByText("Tidy up")).toBeTruthy();
		expect(screen.getByText("5 min ago")).toBeTruthy();
		expect(screen.getByText("Docs")).toBeTruthy();
	});

	it("goes back to the projects it was opened from", async () => {
		fakeServer({ "GET /api/board/cards": { cards: [] }, "GET /projects/p1": PROJECT, "GET /projects": [PROJECT] });
		const app = await openApp("/");
		await fireEvent.press(await screen.findByRole("button", { name: "Shop" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1"));
		await fireEvent.press(await screen.findByRole("button", { name: "Projects" }));
		await waitFor(() => expect(app.getPathname()).toBe("/"));
	});

	it("goes back to the projects from a board opened by a link", async () => {
		fakeServer({ "GET /api/board/cards": { cards: [] }, "GET /projects/p1": PROJECT, "GET /projects": [PROJECT] });
		const app = await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("button", { name: "Projects" }));
		await waitFor(() => expect(app.getPathname()).toBe("/"));
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
		expect(screen.queryByRole("button", { name: /^GitHub/ })).toBeNull();
		await fireEvent.press(tabButton("More"));
		await fireEvent.press(await screen.findByRole("button", { name: "Roadmap" }));
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

describe("board over the live stream", () => {
	/** A stream that opens at once, and lets the test push a board event. */
	class OpenSocket {
		static last: OpenSocket | null = null;
		onopen: (() => void) | null = null;
		onmessage: ((message: { data: unknown }) => void) | null = null;
		onclose: (() => void) | null = null;
		constructor() {
			OpenSocket.last = this;
			queueMicrotask(() => this.onopen?.());
		}
		close() {}
	}
	const realWebSocket = globalThis.WebSocket;
	afterEach(() => {
		globalThis.WebSocket = realWebSocket;
	});

	it("says it is live, and shows an empty column when its last card moves away", async () => {
		globalThis.WebSocket = OpenSocket as unknown as typeof WebSocket;
		let cards = [card("005-red", "Red build", { column: "build_failed" })];
		fakeServer({ "GET /api/board/cards": () => ({ cards }), "GET /projects/p1": PROJECT });
		await openApp("/projects/p1");
		expect(await screen.findByText("Live")).toBeTruthy();
		await fireEvent.press(await screen.findByRole("tab", { name: /Red Build/ }));
		expect(screen.getByText("Red build")).toBeTruthy();

		cards = [{ ...cards[0], column: "done" }];
		OpenSocket.last?.onmessage?.({ data: JSON.stringify({ event_type: "spec_updated", data: {} }) });
		// The column the person chose is gone with its card.
		await waitFor(() => expect(screen.queryByText("Red build")).toBeNull());
		expect(screen.queryByRole("tab", { name: /Red Build/ })).toBeNull();
		expect(screen.getByText("No card here.")).toBeTruthy();
	});
});
