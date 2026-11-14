import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const RUNNERS = ["board.read", "insight.read", "agent.execute", "agent.cancel", "task.write"];
const snapshot = (file: string, content: unknown, job: unknown = null) => ({
	files: content === null ? {} : { [file]: { content: JSON.stringify(content), sha256: "x" } },
	job,
});
const job = (status: string, error: string | null = null) => ({
	id: "job-1",
	feature: "roadmap",
	status,
	started_by: "u1",
	started_at: null,
	finished_at: null,
	error,
});

const ROADMAP = {
	vision: "The fastest shop on the web",
	phases: [
		{ id: "ph2", name: "Grow", description: "After launch", order: 2 },
		{ id: "ph1", name: "Launch", description: "", order: 1 },
	],
	features: [
		{ id: "f1", title: "Checkout", description: "One-page checkout", priority: "must", status: "planned", phase_id: "ph1" },
		{ id: "f2", title: "Wishlist", description: "Save for later", priority: "could", phase_id: "ph2", linked_spec_id: "009-wish" },
		{ id: "f3", title: "Gift cards", description: "Sell gift cards", priority: "exotic", phase_id: "gone" },
	],
};

afterEach(() => {
	restoreFetch();
});

describe("roadmap", () => {
	it("says there is no roadmap yet and generates one", async () => {
		const server = fakeServer(
			{
				"GET /api/features/roadmap/snapshot": snapshot("roadmap.json", null),
				"POST /api/features/roadmap/jobs": job("queued"),
			},
			RUNNERS,
		);
		await openApp("/projects/p1/roadmap");
		expect(await screen.findByText(/No roadmap yet/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Generate" }));
		expect(await screen.findByText("An agent is working on it…")).toBeTruthy();
		expect(server.called("POST /api/features/roadmap/jobs")[0].body).toEqual({});
	});

	it("shows the vision and the features by phase, with their labels", async () => {
		fakeServer({ "GET /api/features/roadmap/snapshot": snapshot("roadmap.json", ROADMAP) }, RUNNERS);
		await openApp("/projects/p1/roadmap");
		expect(await screen.findByText("The fastest shop on the web")).toBeTruthy();
		const titles = ["Launch", "Grow", "Other features"].map((t) => screen.getByText(t));
		expect(titles).toHaveLength(3);
		expect(screen.getByText("After launch")).toBeTruthy();
		expect(screen.getByText("Must have · Planned")).toBeTruthy();
		// An unknown priority is shown as written; the default status is an idea.
		expect(screen.getByText("exotic · Idea")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Generate again" })).toBeTruthy();
	});

	it("regenerates an existing roadmap, and shows why the last run failed", async () => {
		const server = fakeServer(
			{
				"GET /api/features/roadmap/snapshot": snapshot("roadmap.json", ROADMAP, job("failed", "quota exceeded")),
				"POST /api/features/roadmap/jobs": job("running"),
			},
			RUNNERS,
		);
		await openApp("/projects/p1/roadmap");
		expect(await screen.findByText("The last run failed. quota exceeded")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Generate again" }));
		await waitFor(() => expect(server.called("POST /api/features/roadmap/jobs")).toHaveLength(1));
		expect(server.called("POST /api/features/roadmap/jobs")[0].body).toEqual({ refresh: true });
	});

	it("stops a running job", async () => {
		const server = fakeServer(
			{
				"GET /api/features/roadmap/snapshot": snapshot("roadmap.json", null, job("running")),
				"POST /api/features/roadmap/jobs/job-1/cancel": { cancelled: true },
			},
			RUNNERS,
		);
		await openApp("/projects/p1/roadmap");
		await fireEvent.press(await screen.findByRole("button", { name: "Stop" }));
		await waitFor(() => expect(server.called("POST /api/features/roadmap/jobs/job-1/cancel")).toHaveLength(1));
	});

	it("turns a feature into a card and opens it; opens the card a feature already became", async () => {
		const server = fakeServer(
			{
				"GET /api/features/roadmap/snapshot": snapshot("roadmap.json", ROADMAP),
				"POST /api/features/roadmap/features/f1/convert": { card: { id: "010-checkout" } },
				"GET /api/board/cards": { cards: [] },
			},
			RUNNERS,
		);
		const app = await openApp("/projects/p1/roadmap");
		await fireEvent.press(await screen.findByRole("button", { name: /Checkout/ }));
		expect(screen.getByText("One-page checkout")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Turn into a card" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/010-checkout"));
		expect(server.called("POST /api/features/roadmap/features/f1/convert")).toHaveLength(1);
		// The snapshot was read again so the feature now shows its card.
		expect(server.called("GET /api/features/roadmap/snapshot").length).toBeGreaterThanOrEqual(2);
	});

	it("opens the card a feature already became, and says why a conversion failed", async () => {
		fakeServer(
			{
				"GET /api/features/roadmap/snapshot": snapshot("roadmap.json", ROADMAP),
				"POST /api/features/roadmap/features/f1/convert": reply(409, { detail: "already converted" }),
				"GET /api/board/cards": { cards: [] },
			},
			RUNNERS,
		);
		const app = await openApp("/projects/p1/roadmap");
		await fireEvent.press(await screen.findByRole("button", { name: /Checkout/ }));
		await fireEvent.press(screen.getByRole("button", { name: "Turn into a card" }));
		expect(await screen.findByText(/already converted/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: /Wishlist/ }));
		await fireEvent.press(screen.getByRole("button", { name: "Open its card" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/009-wish"));
	});

	it("is read only without agent.execute or task.write", async () => {
		fakeServer({ "GET /api/features/roadmap/snapshot": snapshot("roadmap.json", ROADMAP, job("running")) }, [
			"board.read",
			"insight.read",
		]);
		await openApp("/projects/p1/roadmap");
		expect(await screen.findByText("An agent is working on it…")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: /Checkout/ }));
		expect(screen.queryByRole("button", { name: "Turn into a card" })).toBeNull();
	});

	it("shows why the roadmap cannot be read", async () => {
		fakeServer({ "GET /api/features/roadmap/snapshot": reply(500, { detail: "clone missing" }) }, RUNNERS);
		await openApp("/projects/p1/roadmap");
		expect(await screen.findByText(/clone missing/)).toBeTruthy();
	});
});

describe("ideas", () => {
	const IDEAS = {
		ideas: [
			{ id: "i1", type: "security_hardening", title: "Rate-limit login", description: "Stop brute force", rationale: "Seen in logs", severity: "high" },
			{ id: "i2", type: "security_hardening", title: "Rotate keys", description: "Yearly", status: "dismissed" },
			{ id: "i3", type: "code_quality", title: "Split the cart module", description: "Too big", estimated_effort: "small", linked_task_id: "011-cart" },
			{ id: "i4", type: "unknown_type", title: "Ignored" },
		],
	};

	it("groups the ideas by type, hides dismissed ones and opens one", async () => {
		fakeServer({ "GET /api/features/ideation/snapshot": snapshot("ideation.json", IDEAS) }, RUNNERS);
		await openApp("/projects/p1/ideas");
		expect(await screen.findByText("Security (1)")).toBeTruthy();
		expect(screen.getByText("Code quality (1)")).toBeTruthy();
		expect(screen.queryByText("Rotate keys")).toBeNull();
		expect(screen.queryByText("Ignored")).toBeNull();
		expect(screen.getByText("high")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: /Rate-limit login/ }));
		expect(screen.getByText("Stop brute force")).toBeTruthy();
		expect(screen.getByText("Seen in logs")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: /Rate-limit login/ }));
		expect(screen.queryByText("Stop brute force")).toBeNull();
	});

	it("asks for more ideas on top of the existing ones, and for a first batch otherwise", async () => {
		const server = fakeServer(
			{
				"GET /api/features/ideation/snapshot": snapshot("ideation.json", IDEAS),
				"POST /api/features/ideation/jobs": job("queued"),
			},
			RUNNERS,
		);
		await openApp("/projects/p1/ideas");
		await fireEvent.press(await screen.findByRole("button", { name: "Generate again" }));
		await waitFor(() => expect(server.called("POST /api/features/ideation/jobs")).toHaveLength(1));
		expect(server.called("POST /api/features/ideation/jobs")[0].body).toEqual({ append: true });
	});

	it("says there is no idea yet, and shows why generation was refused", async () => {
		fakeServer(
			{
				"GET /api/features/ideation/snapshot": snapshot("ideation.json", null),
				"POST /api/features/ideation/jobs": reply(409, { detail: "a job already runs" }),
			},
			RUNNERS,
		);
		await openApp("/projects/p1/ideas");
		expect(await screen.findByText(/No ideas yet/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Generate" }));
		expect(await screen.findByText(/a job already runs/)).toBeTruthy();
	});

	it("turns an idea into a card", async () => {
		const server = fakeServer(
			{
				"GET /api/features/ideation/snapshot": snapshot("ideation.json", IDEAS),
				"POST /api/features/ideation/ideas/i1/convert": { card: { id: "012-rate" } },
				"GET /api/board/cards": { cards: [] },
			},
			RUNNERS,
		);
		const app = await openApp("/projects/p1/ideas");
		await fireEvent.press(await screen.findByRole("button", { name: /Rate-limit login/ }));
		await fireEvent.press(screen.getByRole("button", { name: "Turn into a card" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/012-rate"));
		expect(server.called("POST /api/features/ideation/ideas/i1/convert")).toHaveLength(1);
	});
});

describe("new card", () => {
	it("creates a card with its type and review choice, then opens it", async () => {
		const server = fakeServer(
			{
				"GET /api/board/engines": { engines: [] },
				"POST /api/board/cards": { id: "013-dark", title: "Dark mode" },
				"GET /api/board/cards": { cards: [] },
			},
			RUNNERS,
		);
		const app = await openApp("/projects/p1/new");
		const create = await screen.findByRole("button", { name: "Create" });
		expect(create).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Title"), "  Dark mode  ");
		await fireEvent.changeText(screen.getByLabelText("Description"), " Follow the system theme ");
		await fireEvent.press(screen.getByRole("radio", { name: "Bug fix" }));
		await fireEvent(screen.getByLabelText("Review the spec before coding"), "valueChange", false);
		await fireEvent.press(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/013-dark"));
		expect(server.called("POST /api/board/cards")[0].body).toEqual({
			title: "Dark mode",
			description: "Follow the system theme",
			kind: "bug_fix",
			require_review: false,
		});
	});

	it("shows why the server refused the card and keeps the form", async () => {
		fakeServer(
			{
				// An older server answers no engine list.
				"GET /api/board/engines": reply(404, {}),
				"POST /api/board/cards": reply(422, { detail: "title already used" }),
			},
			RUNNERS,
		);
		await openApp("/projects/p1/new");
		await fireEvent.changeText(await screen.findByLabelText("Title"), "Dark mode");
		await fireEvent.press(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText(/title already used/)).toBeTruthy();
		expect(screen.getByDisplayValue("Dark mode")).toBeTruthy();
	});
});
