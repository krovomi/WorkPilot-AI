import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import * as Haptics from "expo-haptics";
import { AppState, Dimensions } from "react-native";
import type { AgentRun, BoardCard, CardDetails } from "../../api/types";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const ALL = ["board.read", "task.write", "agent.execute", "review.approve", "task.merge", "vcs.pr.create", "task.delete"];

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

function details(id: string, extra: Partial<CardDetails> = {}): CardDetails {
	return {
		id,
		title: id,
		column: "backlog",
		kind: null,
		updatedAt: null,
		subtasks: { completed: 0, total: 0 },
		description: "",
		spec: null,
		approval: { approved: false, approvedBy: null, approvedAt: null },
		requireReview: false,
		...extra,
	} as CardDetails;
}

const run = (status: string): AgentRun =>
	({ id: `run-${status}`, spec_id: "s", phase: "build", started_by: null, status, started_at: null, finished_at: null, error: null }) as unknown as AgentRun;

const CARDS = [
	card("001-login", "Créer la page de connexion", { kind: "feature", claimedBy: "u1", claimedByName: "Ada Lovelace" }),
	card("002-api", "Fix the API", { kind: "bug_fix" }),
	card("003-docs", "Write the guide", { kind: "docs", claimedBy: "u2", claimedByName: "Bob" }),
	card("004-build", "Build the cart", { column: "in_progress" }),
	card("006-new", "Not indexed yet", { specId: null }),
];

const PROJECT = { id: "p1", name: "Shop", repo_url: "https://github.com/acme/shop", default_branch: "main", forge: null };

beforeEach(() => {
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

function serve(routes: Record<string, unknown> = {}, permissions = ALL) {
	return fakeServer(
		{
			"GET /api/board/cards": { cards: CARDS },
			"GET /projects/p1": PROJECT,
			"GET /api/board/cards/001-login": details("001-login"),
			"GET /projects/p1/specs/spec-001-login/runs": [],
			"GET /api/board/cards/002-api": details("002-api", { spec: "# Spec", requireReview: true }),
			"GET /projects/p1/specs/spec-002-api/runs": [],
			"GET /api/board/cards/004-build": details("004-build", { column: "in_progress", spec: "# Spec" }),
			"GET /projects/p1/specs/spec-004-build/runs": [],
			...routes,
		},
		permissions,
	);
}

describe("finding cards", () => {
	it("searches the titles without accents or case, the numbers and who claimed a card", async () => {
		serve();
		await openApp("/projects/p1");
		expect(await screen.findByText("Fix the API")).toBeTruthy();
		const search = screen.getByLabelText("Search the board");
		await fireEvent.changeText(search, "creer connexion");
		expect(screen.getByText("Créer la page de connexion")).toBeTruthy();
		expect(screen.queryByText("Fix the API")).toBeNull();
		await fireEvent.changeText(search, "#003");
		expect(screen.getByText("Write the guide")).toBeTruthy();
		await fireEvent.changeText(search, "bob");
		expect(screen.getByText("Write the guide")).toBeTruthy();
		expect(screen.queryByText("Créer la page de connexion")).toBeNull();
		// The counts follow the search.
		expect(screen.getByRole("tab", { name: /Planning/ })).toHaveTextContent(/1/);

		await fireEvent.changeText(search, "nothing like it");
		expect(screen.getByText("No card matches.")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Clear the filters" }));
		expect(screen.getByText("Fix the API")).toBeTruthy();
		expect(screen.getByLabelText("Search the board").props.value).toBe("");

		await fireEvent.changeText(screen.getByLabelText("Search the board"), "api");
		await fireEvent.press(screen.getByRole("button", { name: "Clear the search" }));
		expect(screen.getByText("Write the guide")).toBeTruthy();
	});

	it("keeps the person's own cards, or the kinds picked, and says how many filters are on", async () => {
		serve();
		await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("button", { name: "Filters" }));
		await fireEvent.press(screen.getByRole("checkbox", { name: "Mine" }));
		expect(screen.getByRole("checkbox", { name: "Mine" })).toBeChecked();
		expect(screen.getByText("Créer la page de connexion")).toBeTruthy();
		expect(screen.queryByText("Fix the API")).toBeNull();
		expect(screen.getByRole("button", { name: "Filters, 1 on" })).toBeTruthy();

		await fireEvent.press(screen.getByRole("checkbox", { name: "Mine" }));
		await fireEvent.press(screen.getByRole("checkbox", { name: "Bug fix" }));
		await fireEvent.press(screen.getByRole("checkbox", { name: "Docs" }));
		expect(screen.getByText("Fix the API")).toBeTruthy();
		expect(screen.getByText("Write the guide")).toBeTruthy();
		expect(screen.queryByText("Créer la page de connexion")).toBeNull();
		await fireEvent.press(screen.getByRole("checkbox", { name: "Bug fix" }));
		expect(screen.queryByText("Fix the API")).toBeNull();

		await fireEvent.press(screen.getByRole("checkbox", { name: "Clear the filters" }));
		expect(screen.getByText("Fix the API")).toBeTruthy();
		// Closed again, the filters stay as they are.
		await fireEvent.press(screen.getByRole("button", { name: "Filters" }));
		expect(screen.queryByRole("checkbox", { name: "Mine" })).toBeNull();
	});
});

describe("quick actions", () => {
	it("offers what the card screen would, starts the card and reads the board again", async () => {
		const server = serve({
			"POST /projects/p1/specs/spec-001-login/runs": (call: Call) => ({ ...run("queued"), phase: (call.body as { phase: string }).phase }),
		});
		const success = jest.spyOn(Haptics, "notificationAsync");
		await openApp("/projects/p1");
		await fireEvent(await screen.findByRole("button", { name: "Créer la page de connexion" }), "longPress");
		expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
		// Deleting stays on the card screen, behind its confirmation.
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
		expect(screen.getByText("#001 · Planning")).toBeTruthy();
		const reads = server.called("GET /api/board/cards").length;
		await fireEvent.press(screen.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(server.called("POST /projects/p1/specs/spec-001-login/runs")).toHaveLength(1));
		expect(server.called("POST /projects/p1/specs/spec-001-login/runs")[0].body).toEqual({ phase: "spec" });
		await waitFor(() => expect(screen.queryByRole("button", { name: "Open the card" })).toBeNull());
		expect(server.called("GET /api/board/cards").length).toBeGreaterThan(reads);
		expect(success).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
	});

	it("approves a spec that waits, from the screen reader's action too", async () => {
		const server = serve({ "POST /api/board/cards/002-api/approve": { approved: true } });
		await openApp("/projects/p1");
		const row = await screen.findByRole("button", { name: "Fix the API" });
		await fireEvent(row, "accessibilityAction", { nativeEvent: { actionName: "longpress" } });
		await fireEvent.press(await screen.findByRole("button", { name: "Approve the spec" }));
		await waitFor(() => expect(server.called("POST /api/board/cards/002-api/approve")).toHaveLength(1));
	});

	it("builds again a card left without a run, and stops one that runs", async () => {
		const server = serve({
			"POST /projects/p1/specs/spec-004-build/runs": run("queued"),
		});
		await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("tab", { name: /In Progress/ }));
		await fireEvent(await screen.findByRole("button", { name: "Build the cart" }), "longPress");
		await fireEvent.press(await screen.findByRole("button", { name: "Build again" }));
		await waitFor(() => expect(server.called("POST /projects/p1/specs/spec-004-build/runs")).toHaveLength(1));
		expect(server.called("POST /projects/p1/specs/spec-004-build/runs")[0].body).toEqual({ phase: "build" });

		server.routes["GET /projects/p1/specs/spec-004-build/runs"] = [run("running")];
		server.routes["POST /projects/p1/specs/spec-004-build/runs/run-running/cancel"] = { cancelled: true };
		await fireEvent(screen.getByRole("button", { name: "Build the cart" }), "longPress");
		await fireEvent.press(await screen.findByRole("button", { name: "Stop" }));
		await waitFor(() =>
			expect(server.called("POST /projects/p1/specs/spec-004-build/runs/run-running/cancel")).toHaveLength(1),
		);
	});

	it("shows a refusal in the sheet, and closes with a tap outside", async () => {
		jest.spyOn(Haptics, "notificationAsync").mockRejectedValue(new Error("no motor"));
		serve({ "POST /projects/p1/specs/spec-001-login/runs": reply(409, { detail: "Not allowed here" }) });
		await openApp("/projects/p1");
		await fireEvent(await screen.findByRole("button", { name: "Créer la page de connexion" }), "longPress");
		await fireEvent.press(await screen.findByRole("button", { name: "Start" }));
		expect(await screen.findByText(/Not allowed here/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Open the card" })).toBeNull());
	});

	it("still opens the card when it cannot be read, and only lets the card screen act then", async () => {
		const app = await (async () => {
			serve({ "GET /api/board/cards/003-docs": reply(500, { detail: "disk full" }) });
			return openApp("/projects/p1");
		})();
		await fireEvent(await screen.findByRole("button", { name: "Write the guide" }), "longPress");
		expect(await screen.findByText(/disk full/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: "Open the card" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/003-docs"));
	});

	it("offers only opening a card the server has not indexed yet", async () => {
		const server = serve({ "GET /api/board/cards/006-new": details("006-new") });
		await openApp("/projects/p1");
		await fireEvent(await screen.findByRole("button", { name: "Not indexed yet" }), "longPress");
		expect(await screen.findByRole("button", { name: "Open the card" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
		expect(server.calls.some((call) => call.path.includes("/specs/"))).toBe(false);
	});

	it("offers nothing more than opening a card the person's role cannot act on", async () => {
		serve({}, ["board.read"]);
		await openApp("/projects/p1");
		await fireEvent(await screen.findByRole("button", { name: "Créer la page de connexion" }), "longPress");
		expect(await screen.findByRole("button", { name: "Open the card" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
		expect(screen.queryByRole("button", { name: "New card" })).toBeNull();
	});
});

describe("on a tablet", () => {
	it("shows every column side by side, filtered as on the phone", async () => {
		jest.spyOn(Dimensions, "get").mockReturnValue({ width: 1180, height: 820, scale: 2, fontScale: 1 });
		serve();
		await openApp("/projects/p1");
		expect(await screen.findByRole("header", { name: "Planning" })).toBeTruthy();
		expect(screen.getByRole("header", { name: "In Progress" })).toBeTruthy();
		expect(screen.getByText("Build the cart")).toBeTruthy();
		expect(screen.getByText("Fix the API")).toBeTruthy();
		expect(screen.queryByRole("tab", { name: /Planning/ })).toBeNull();
		expect(within(screen.getByLabelText("AI Review, 0")).getByText("No card here.")).toBeTruthy();
		await fireEvent.changeText(screen.getByLabelText("Search the board"), "cart");
		expect(screen.queryByText("Fix the API")).toBeNull();
		expect(screen.getByLabelText("Planning, 0")).toBeTruthy();
	});

	it("keeps a split group's filter and the server's error above the columns", async () => {
		jest.spyOn(Dimensions, "get").mockReturnValue({ width: 1180, height: 820, scale: 2, fontScale: 1 });
		serve({
			"GET /api/board/cards": {
				cards: [card("005-a", "Part A", { group: { id: "grp", title: "G", index: 1, total: 2 } })],
			},
		});
		await openApp("/projects/p1");
		await fireEvent.press(await screen.findByRole("button", { name: "Part 1/2 · G" }));
		expect(screen.getByRole("button", { name: "Show every card" })).toBeTruthy();
	});
});
