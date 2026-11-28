import { act, fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { Alert } from "react-native";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

afterEach(() => {
	jest.useRealTimers();
	restoreFetch();
	jest.restoreAllMocks();
});

const confirm = () =>
	jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => {
		void buttons?.find((b) => b.style === "destructive")?.onPress?.();
	});

/** The card of one memory, found by its text. */
function memory(text: string) {
	let node = screen.getByText(text);
	while (node.parent && !within(node.parent).queryAllByRole("button").length) node = node.parent;
	return within(node.parent ?? node);
}

const BASE = "/api/features/context/memory";
const MEMORIES = [
	{ id: "knowledge/projects/shop/memory/gotchas/a.md", type: "gotcha", content: "Run migrations first", pinned: false },
	{ id: "knowledge/projects/shop/memory/patterns/b.md", type: "pattern", content: "Use the cache layer", pinned: true },
];

describe("the team's memory", () => {
	it("pins, unpins and forgets a memory, and searched ones by their path", async () => {
		jest.useFakeTimers();
		let rows = MEMORIES.map((m) => ({ ...m }));
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				"GET /api/features/context/memories": (call: Call) =>
					call.query.get("query")
						? {
								available: true,
								results: [
									{ path: rows[0].id, type: "gotcha", content: rows[0].content, score: 1 },
									{ type: "gotcha", content: "A note without a name", score: 0.5 },
								],
							}
						: { available: true, memories: rows },
				[`POST ${BASE}/pin`]: (call: Call) => {
					const { id, pinned } = call.body as { id: string; pinned: boolean };
					rows = rows.map((m) => (m.id === id ? { ...m, pinned } : m));
					return { success: true };
				},
				[`POST ${BASE}/forget`]: (call: Call) => {
					rows = rows.filter((m) => m.id !== (call.body as { id: string }).id);
					return { success: true };
				},
			},
			["insight.read", "insight.write"],
		);
		confirm();
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Memories" }));
		expect(await screen.findByText("Run migrations first")).toBeTruthy();
		expect(memory("Use the cache layer").getByText("Pinned")).toBeTruthy();
		// A pinned memory is kept: it cannot be forgotten before it is unpinned.
		expect(memory("Use the cache layer").queryByRole("button", { name: "Forget" })).toBeNull();

		await fireEvent.press(memory("Run migrations first").getByRole("button", { name: "Pin" }));
		await waitFor(() => expect(memory("Run migrations first").getByRole("button", { name: "Unpin" })).toBeTruthy());
		expect(server.called(`POST ${BASE}/pin`)[0].body).toEqual({ id: MEMORIES[0].id, pinned: true });
		expect(server.called(`POST ${BASE}/pin`)[0].query.get("project_id")).toBe("p1");
		await fireEvent.press(memory("Use the cache layer").getByRole("button", { name: "Unpin" }));
		await fireEvent.press(await memory("Use the cache layer").findByRole("button", { name: "Forget" }));
		await waitFor(() => expect(screen.queryByText("Use the cache layer")).toBeNull());
		expect(server.called(`POST ${BASE}/forget`)[0].body).toEqual({ id: MEMORIES[1].id, reason: "" });

		await fireEvent.changeText(screen.getByLabelText("Search the memories"), "migrations");
		await act(async () => {
			jest.advanceTimersByTime(400);
		});
		await fireEvent.press(await memory("Run migrations first").findByRole("button", { name: "Pin" }));
		await waitFor(() => expect(server.called(`POST ${BASE}/pin`).at(-1)?.body).toEqual({ id: MEMORIES[0].id, pinned: true }));
		// A note the server did not name cannot be decided on.
		expect(screen.getByText("A note without a name")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Pin" })).toHaveLength(1);
	});

	it("says why the server did not take a decision", async () => {
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				"GET /api/features/context/memories": { available: true, memories: MEMORIES },
				[`POST ${BASE}/pin`]: { success: false, error: "pin-limit", limit: 20 },
				[`POST ${BASE}/forget`]: { success: false, error: "something new" },
			},
			["insight.read", "insight.write"],
		);
		confirm();
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Memories" }));
		await fireEvent.press(await memory("Run migrations first").findByRole("button", { name: "Pin" }));
		expect(await screen.findByText("At most 20 memories can be pinned: unpin one first.")).toBeTruthy();
		await fireEvent.press(memory("Run migrations first").getByRole("button", { name: "Forget" }));
		expect(await screen.findByText("The server did not take this decision.")).toBeTruthy();
		server.routes[`POST ${BASE}/forget`] = reply(409, { detail: "Brain busy" });
		await fireEvent.press(memory("Run migrations first").getByRole("button", { name: "Forget" }));
		expect(await screen.findByText(/Brain busy/)).toBeTruthy();
	});

	it("lets a viewer read without deciding", async () => {
		fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				"GET /api/features/context/memories": { available: true, memories: MEMORIES },
				[`GET ${BASE}/lifecycle`]: {
					success: true,
					trash: [TRASHED[0]],
					pinned: 1,
					pin_limit: 20,
					retention_days: 30,
				},
			},
			["insight.read"],
		);
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Memories" }));
		expect(await screen.findByText("Run migrations first")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
		await fireEvent.press(screen.getByRole("tab", { name: "Trash" }));
		expect(await screen.findByText("Old gotcha")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Put back" })).toBeNull();
	});
});

const TRASHED = [
	{
		id: "gotchas/old.md",
		kind: "gotcha",
		title: "Old gotcha",
		preview: "Was true once",
		forgotten_at: "2026-11-20T10:00:00Z",
		forgotten_by: "Bob",
		reason: "",
		restore_until: "2026-12-20T10:00:00Z",
		expiring_soon: false,
	},
	{
		id: "patterns/soon.md",
		kind: "pattern",
		title: "",
		preview: "Going soon",
		forgotten_at: "2026-10-30T10:00:00Z",
		forgotten_by: "",
		reason: "",
		restore_until: "2026-11-29T10:00:00Z",
		expiring_soon: true,
	},
];

describe("the memory's trash", () => {
	it("lists the forgotten memories and puts one back", async () => {
		let trash = TRASHED;
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				[`GET ${BASE}/lifecycle`]: () => ({ success: true, trash, pinned: 2, pin_limit: 20, retention_days: 30 }),
				[`POST ${BASE}/restore`]: (call: Call) => {
					trash = trash.filter((m) => m.id !== (call.body as { id: string }).id);
					return { success: true };
				},
			},
			["insight.read", "insight.write"],
		);
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Trash" }));
		expect(await screen.findByText(/stays 30 days in the trash. 2 of 20 memories are pinned/)).toBeTruthy();
		expect(screen.getByText(/Forgotten by Bob/)).toBeTruthy();
		expect(screen.getByText(/^Forgotten \d/)).toBeTruthy();
		expect(screen.getAllByText(/Can be put back until/)).toHaveLength(2);
		await fireEvent.press(memory("Going soon").getByRole("button", { name: "Put back" }));
		await waitFor(() => expect(screen.queryByText("Going soon")).toBeNull());
		expect(server.called(`POST ${BASE}/restore`)[0].body).toEqual({ id: "patterns/soon.md" });
	});

	it("says when the trash is empty, when there is no memory yet, and why it did not load", async () => {
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				[`GET ${BASE}/lifecycle`]: { success: true },
			},
			["insight.read", "insight.write"],
		);
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Trash" }));
		expect(await screen.findByText("Nothing in the trash.")).toBeTruthy();
		expect(screen.getByText(/stays 0 days in the trash/)).toBeTruthy();

		server.routes[`GET ${BASE}/lifecycle`] = { success: false, error: "no-brain" };
		await fireEvent.press(screen.getByRole("tab", { name: "Index" }));
		await fireEvent.press(screen.getByRole("tab", { name: "Trash" }));
		expect(await screen.findByText(/No memories yet: the project's first build/)).toBeTruthy();

		server.routes[`GET ${BASE}/lifecycle`] = reply(409, { detail: "Trash offline" });
		await fireEvent.press(screen.getByRole("tab", { name: "Index" }));
		await fireEvent.press(screen.getByRole("tab", { name: "Trash" }));
		expect(await screen.findByText(/Trash offline/)).toBeTruthy();
		expect(screen.queryByText(/No memories yet/)).toBeNull();
	});

	it("says why a memory was not put back", async () => {
		const server = fakeServer(
			{
				"GET /api/features/context/snapshot": { files: {}, job: null },
				[`GET ${BASE}/lifecycle`]: { success: true, trash: TRASHED, pinned: 0, pin_limit: 20, retention_days: 30 },
				[`POST ${BASE}/restore`]: { success: false, error: "expired" },
			},
			["insight.read", "insight.write"],
		);
		await openApp("/projects/p1/context");
		await fireEvent.press(await screen.findByRole("tab", { name: "Trash" }));
		await fireEvent.press(await memory("Was true once").findByRole("button", { name: "Put back" }));
		expect(await screen.findByText("It stayed too long in the trash to be put back.")).toBeTruthy();
		server.routes[`POST ${BASE}/restore`] = { success: false };
		await fireEvent.press(memory("Was true once").getByRole("button", { name: "Put back" }));
		expect(await screen.findByText("The server did not take this decision.")).toBeTruthy();
	});
});

const REPO = "/repos/acme/shop";
const REVIEWS = "/api/features/forge/github/reviews";
const REVIEW = JSON.stringify({
	verdict: "needs_changes",
	summary: "Two remarks",
	findings: [
		{ id: "f1", severity: "high", title: "SQL built by hand", description: "Use parameters" },
		{ id: "f2", severity: "low", title: "Name too short", description: "Say what it holds" },
	],
});

function pullServer(routes: Record<string, unknown>, permissions = ["vcs.read", "task.write"], forge = "github") {
	const answers: Record<string, unknown> = {
		[`GET ${REPO}/pulls/41`]: {
			number: 41,
			title: "Add search",
			body: "",
			state: "open",
			user: { login: "bob" },
			head: { ref: "feat/search", sha: "abc1234" },
			base: { ref: "develop" },
			mergeable: true,
		},
		[`GET ${REPO}/pulls/41/files?per_page=100`]: [],
		[`GET ${REPO}/issues/41/comments?per_page=100`]: [],
		[`GET ${REPO}/commits/abc1234/check-runs?per_page=100`]: { check_runs: [] },
	};
	const relay = (call: Call) => {
		const { method, endpoint } = call.body as { method: string; endpoint: string };
		const answer = answers[`${method} ${endpoint}`];
		return reply(200, answer === undefined ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: answer });
	};
	return fakeServer(
		{
			"GET /projects/p1": { id: "p1", name: "Shop", repo_url: "https://github.com/acme/shop", default_branch: "main", forge },
			"POST /api/features/forge/github/read": relay,
			[`GET ${REVIEWS}`]: { reviews: { "41": REVIEW } },
			...routes,
		},
		permissions,
	);
}

/** The card of one finding, found by its title. */
function finding(title: string) {
	let node = screen.getByText(title);
	while (node.parent && !within(node.parent).queryAllByRole("button").length) node = node.parent;
	return within(node.parent ?? node);
}

describe("feedback on the AI review", () => {
	it("says a remark was useful, or why not, and shows what the team said", async () => {
		let view = { feedback: { f2: "accepted" } as Record<string, string>, held: [] as string[] };
		const server = pullServer({
			[`GET ${REVIEWS}/41/feedback`]: () => view,
			[`POST ${REVIEWS}/41/feedback`]: (call: Call) => {
				const body = call.body as { finding_id: string; verdict: string };
				view = { feedback: { ...view.feedback, [body.finding_id]: body.verdict }, held: view.held };
				if (body.verdict !== "accepted") view.held = [body.finding_id];
				return view;
			},
			[`GET ${REVIEWS}/feedback`]: { maintainer: false, dataset: "" },
		});
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByText("SQL built by hand")).toBeTruthy();
		// The chip says what the team said, beside the button that says it.
		await waitFor(() => expect(finding("Name too short").getAllByText("Useful")).toHaveLength(2));
		expect(finding("Name too short").getByRole("button", { name: "Useful" }).props.accessibilityState.disabled).toBe(true);

		await fireEvent.press(finding("SQL built by hand").getByRole("button", { name: "Not useful" }));
		expect(screen.getByText("Why is it not useful?")).toBeTruthy();
		await fireEvent.press(finding("SQL built by hand").getByRole("button", { name: "Not useful" }));
		expect(screen.queryByText("Why is it not useful?")).toBeNull();
		await fireEvent.press(finding("SQL built by hand").getByRole("button", { name: "Not useful" }));
		await fireEvent.press(screen.getByRole("button", { name: "Our convention" }));
		expect(await screen.findByText("Waiting for a maintainer")).toBeTruthy();
		expect(server.called(`POST ${REVIEWS}/41/feedback`)[0].body).toEqual({
			finding_id: "f1",
			verdict: "rejected",
			reason: "project_convention",
		});
		// A newcomer's rejection is held: the list asked, the person may not settle it.
		await waitFor(() => expect(server.called(`GET ${REVIEWS}/feedback`).length).toBeGreaterThan(0));
		expect(screen.queryByText("Rejections waiting for you")).toBeNull();

		await fireEvent.press(finding("Name too short").getByRole("button", { name: "Not useful" }));
		await fireEvent.press(screen.getByRole("button", { name: "Does not apply here" }));
		await waitFor(() =>
			expect(server.called(`POST ${REVIEWS}/41/feedback`).at(-1)?.body).toEqual({ finding_id: "f2", verdict: "not_applicable" }),
		);
		await fireEvent.press(finding("SQL built by hand").getByRole("button", { name: "Useful" }));
		await waitFor(() =>
			expect(server.called(`POST ${REVIEWS}/41/feedback`).at(-1)?.body).toEqual({ finding_id: "f1", verdict: "accepted" }),
		);
	});

	it("lets a maintainer approve or discard a held rejection", async () => {
		let held = [
			{ pr: 41, finding_id: "f1", verdict: "rejected", reason: "false_positive", title: "SQL built by hand", severity: "high" },
			{ pr: 41, finding_id: "f2", verdict: "not_applicable", reason: null, title: "Name too short", severity: "low" },
			{ pr: 7, finding_id: "x", verdict: "rejected", reason: "other", title: "Elsewhere", severity: "low" },
		];
		const server = pullServer({
			[`GET ${REVIEWS}/41/feedback`]: () => ({
				feedback: Object.fromEntries(held.filter((h) => h.pr === 41).map((h) => [h.finding_id, h.verdict])),
				held: held.filter((h) => h.pr === 41).map((h) => h.finding_id),
			}),
			[`GET ${REVIEWS}/feedback`]: () => ({ held, maintainer: true, dataset: "" }),
			[`POST ${REVIEWS}/feedback/held`]: (call: Call) => {
				const body = call.body as { finding_id: string };
				held = held.filter((h) => h.finding_id !== body.finding_id);
				return { done: true };
			},
		});
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByText("Rejections waiting for you")).toBeTruthy();
		expect(screen.getByText("Not useful · It is wrong")).toBeTruthy();
		expect(screen.getAllByText("Does not apply")).toHaveLength(2);
		expect(screen.queryByText("Elsewhere")).toBeNull();
		await fireEvent.press(screen.getAllByRole("button", { name: "Approve" })[0]);
		await waitFor(() => expect(server.called(`POST ${REVIEWS}/feedback/held`)).toHaveLength(1));
		expect(server.called(`POST ${REVIEWS}/feedback/held`)[0].body).toEqual({ pr: 41, finding_id: "f1", approve: true });
		await fireEvent.press(await screen.findByRole("button", { name: "Discard" }));
		await waitFor(() => expect(screen.queryByText("Rejections waiting for you")).toBeNull());
		expect(server.called(`POST ${REVIEWS}/feedback/held`)[1].body).toEqual({ pr: 41, finding_id: "f2", approve: false });
	});

	it("says why the feedback was not taken, and offers nothing to a reader", async () => {
		pullServer({
			[`GET ${REVIEWS}/41/feedback`]: { feedback: {}, held: [] },
			[`POST ${REVIEWS}/41/feedback`]: reply(409, { detail: "Feedback unavailable" }),
		});
		await openApp("/projects/p1/forge/pulls/41");
		await fireEvent.press(await finding("SQL built by hand").findByRole("button", { name: "Useful" }));
		expect(await screen.findByText(/Feedback unavailable/)).toBeTruthy();
	});

	it("offers no feedback to someone who may not write on the project", async () => {
		pullServer({ [`GET ${REVIEWS}/41/feedback`]: { feedback: {}, held: [] } }, ["vcs.read"]);
		await openApp("/projects/p1/forge/pulls/41");
		expect(await screen.findByText("SQL built by hand")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Useful" })).toBeNull();
	});
});
