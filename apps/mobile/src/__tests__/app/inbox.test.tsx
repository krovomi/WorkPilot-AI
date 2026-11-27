import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const SHOP = { id: "p1", name: "Shop", repo_url: "https://github.com/acme/shop.git", default_branch: "main" };
const BLOG = { ...SHOP, id: "p2", name: "Blog" };
const DOWN = { ...SHOP, id: "p3", name: "Down" };

const card = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	title: `Card ${id}`,
	column: "human_review",
	kind: null,
	updatedAt: "2026-11-22T10:00:00Z",
	subtasks: { completed: 0, total: 0 },
	specId: "s1",
	claimedBy: null,
	claimedByName: null,
	...over,
});

const BOARDS: Record<string, unknown> = {
	p1: { cards: [card("004-plan", { reviewReason: "plan_review" }), card("003-done", { updatedAt: null }), card("009-theirs", { claimedBy: "u2" })] },
	p2: { cards: [card("007-broke", { reviewReason: "errors" }), card("010-coding", { column: "in_progress" })] },
	p3: reply(500, { detail: "down" }),
};
const boards = (call: Call) => BOARDS[call.query.get("project_id") ?? ""];
const RIGHTS = ["board.read", "review.approve", "agent.execute", "task.merge"];

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("the projects list", () => {
	it("says how many cards wait for the person, and opens them", async () => {
		fakeServer({ "GET /projects": [SHOP, BLOG], "GET /api/board/cards": boards }, RIGHTS);
		const app = await openApp("/");
		expect(await screen.findByText("3 cards wait for you")).toBeTruthy();
		expect(screen.getByText("1 plan to approve · 1 to look at · 1 to review")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "3 cards wait for you" }));
		await waitFor(() => expect(app.getPathname()).toBe("/inbox"));
	});

	it("says nothing when nothing waits, and keeps the inbox one tap away", async () => {
		fakeServer({ "GET /projects": [SHOP], "GET /api/board/cards": { cards: [] } }, RIGHTS);
		const app = await openApp("/");
		expect(await screen.findByText("1 project")).toBeTruthy();
		expect(screen.queryByText(/wait for you/)).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: "What waits for you" }));
		await waitFor(() => expect(app.getPathname()).toBe("/inbox"));
	});
});

describe("the inbox", () => {
	it("groups the cards by what to do, names the boards it could not read, and opens a card", async () => {
		fakeServer({ "GET /projects": [SHOP, BLOG, DOWN], "GET /api/board/cards": boards }, RIGHTS);
		const app = await openApp("/inbox");
		expect(await screen.findByRole("header", { name: "Plans to approve · 1" })).toBeTruthy();
		expect(screen.getByRole("header", { name: "Stopped, to look at · 1" })).toBeTruthy();
		expect(screen.getByRole("header", { name: "Done, to review · 1" })).toBeTruthy();
		expect(screen.getByText("Shop · #004")).toBeTruthy();
		expect(screen.getByText("Could not read: Down. Pull to try again.")).toBeTruthy();
		// Someone else's card, and one still being coded, are not the person's to act on.
		expect(screen.queryByText("Card 009-theirs")).toBeNull();
		expect(screen.queryByText("Card 010-coding")).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: "Card 007-broke, Blog" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p2/cards/007-broke"));
	});

	it("says when nothing waits, and only what the person's role can act on", async () => {
		fakeServer({ "GET /projects": [SHOP, BLOG], "GET /api/board/cards": boards }, ["board.read"]);
		await openApp("/inbox");
		expect(await screen.findByText("Nothing waits for you.")).toBeTruthy();
	});

	it("shows the server's error instead of an empty inbox", async () => {
		fakeServer({ "GET /projects": reply(500, { detail: "database down" }) }, RIGHTS);
		await openApp("/inbox");
		expect(await screen.findByText(/database down/)).toBeTruthy();
		expect(screen.queryByText("Nothing waits for you.")).toBeNull();
	});
});
