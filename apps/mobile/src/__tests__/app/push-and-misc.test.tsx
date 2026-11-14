import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import * as Notifications from "expo-notifications";
import { Alert, AppState } from "react-native";
import type { BoardCard } from "../../api/types";
import { saveLockSettings } from "../../auth/lock";
import { type FakeServer, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

// The app's config, with an EAS project only where a test gives one (registration needs it).
// expo-router reads the config at import, before `mockEas` is set: hence the `?.`.
const mockEas: { projectId: string | null } = { projectId: null };
jest.mock("expo-constants", () => {
	const actual = jest.requireActual("expo-constants").default;
	const constants = Object.create(actual);
	Object.defineProperty(constants, "expoConfig", {
		get: () => ({ ...actual.expoConfig, extra: { ...actual.expoConfig?.extra, eas: { projectId: mockEas?.projectId ?? null } } }),
	});
	return { __esModule: true, default: constants };
});

const CARD: BoardCard = {
	id: "007-search",
	title: "Search the catalogue",
	column: "human_review",
	kind: null,
	updatedAt: null,
	subtasks: { completed: 0, total: 0 },
	specId: "spec-7",
	claimedBy: null,
	claimedByName: null,
};

function tapped(actionIdentifier: string, data: Record<string, unknown>, identifier = "n1") {
	(Notifications.useLastNotificationResponse as jest.Mock).mockReturnValue({
		actionIdentifier,
		notification: { request: { identifier, content: { data } } },
	});
}

function board(extra: Record<string, unknown> = {}): FakeServer {
	return fakeServer(
		{
			"GET /projects": [],
			"GET /api/board/cards": { cards: [CARD] },
			"GET /api/board/cards/007-search": { ...CARD, description: "", spec: "x", approval: { approved: false }, requireReview: true },
			"GET /projects/p1/specs/spec-7/runs": [],
			"GET /api/board/cards/007-search/steering": { messages: [] },
			"GET /api/board/cards/007-search/logs": { logs: null },
			...extra,
		},
		["board.read", "review.approve", "agent.execute"],
	);
}

const RUN_FINISHED = { type: "run_finished", projectId: "p1", cardId: "007-search" };

beforeEach(async () => {
	jest.clearAllMocks();
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
	await saveLockSettings({ atLaunch: false, sensitive: false });
});

afterEach(() => {
	(Notifications.useLastNotificationResponse as jest.Mock).mockReturnValue(null);
	restoreFetch();
	jest.restoreAllMocks();
});

describe("notifications", () => {
	it("sets up the plan buttons in the person's language once signed in", async () => {
		board();
		await openApp("/");
		await waitFor(() => expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalled());
		const [, actions] = (Notifications.setNotificationCategoryAsync as jest.Mock).mock.calls[0];
		expect(actions.map((a: { buttonTitle: string }) => a.buttonTitle)).toEqual(["Approve and build", "View"]);
	});

	it("opens the card of a tapped notification, once", async () => {
		tapped(Notifications.DEFAULT_ACTION_IDENTIFIER, RUN_FINISHED);
		board();
		const app = await openApp("/");
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/007-search"));
		expect(Notifications.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
	});

	it("ignores a notification that is not ours", async () => {
		tapped(Notifications.DEFAULT_ACTION_IDENTIFIER, { type: "marketing" });
		board();
		const app = await openApp("/");
		await screen.findByText("No project yet. Add one from the desktop app.");
		expect(app.getPathname()).toBe("/");
		expect(Notifications.clearLastNotificationResponseAsync).not.toHaveBeenCalled();
	});

	it("approves a plan from its button, builds it, then opens the card", async () => {
		tapped("approve", { ...RUN_FINISHED, awaitingApproval: true }, "n2");
		const server = board({
			"POST /api/board/cards/007-search/approve": {},
			"POST /projects/p1/specs/spec-7/runs": { id: "r", status: "queued" },
		});
		const app = await openApp("/");
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/007-search"));
		expect(server.called("POST /api/board/cards/007-search/approve")).toHaveLength(1);
		expect(server.called("POST /projects/p1/specs/spec-7/runs")[0].body).toEqual({ phase: "build" });
	});

	it("says the plan was not approved, and still opens the card", async () => {
		tapped("approve", { ...RUN_FINISHED, awaitingApproval: true }, "n3");
		const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
		board({ "POST /api/board/cards/007-search/approve": reply(403, {}) });
		const app = await openApp("/");
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/cards/007-search"));
		expect(alert).toHaveBeenCalledWith("The plan was not approved", "You don't have the rights for this action.");
	});

	describe("with an EAS project", () => {
		beforeEach(() => {
			mockEas.projectId = "eas-123";
		});
		afterEach(() => {
			mockEas.projectId = null;
		});

		it("registers this phone with the server once signed in, in the person's language", async () => {
			const server = board();
			await openApp("/");
			await waitFor(() => expect(server.called("PUT /users/me/devices")).toHaveLength(1));
			expect(server.called("PUT /users/me/devices")[0].body).toEqual({
				token: "ExponentPushToken[testtesttest]",
				platform: "ios",
				locale: "en",
			});
		});

		it("keeps working without notifications when the phone gets no token", async () => {
			(Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValueOnce(new Error("no Firebase file"));
			const server = board({ "GET /projects": [{ id: "p1", name: "Shop", repo_url: "", default_branch: "main" }] });
			await openApp("/");
			expect(await screen.findByText("Shop")).toBeTruthy();
			expect(server.called("PUT /users/me/devices")).toHaveLength(0);
		});
	});

	it("keeps working when the phone cannot set up the buttons", async () => {
		(Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(new Error("unsupported"));
		board({ "GET /projects": [{ id: "p1", name: "Shop", repo_url: "", default_branch: "main" }] });
		await openApp("/");
		expect(await screen.findByText("Shop")).toBeTruthy();
	});
});

describe("forge on GitLab", () => {
	const PROJECT = { id: "p1", name: "Shop", repo_url: "https://gitlab.com/acme/shop.git", default_branch: "main", forge: "gitlab" };
	const ENC = "/projects/acme%2Fshop";
	const relayed = (status: number, body: unknown) => reply(200, { status, body });
	function gitlab(answers: Record<string, unknown>) {
		const relay = (call: { body: unknown }) => {
			const { method, endpoint } = call.body as { method: string; endpoint: string };
			const answer = answers[`${method} ${endpoint}`];
			return answer === undefined ? relayed(404, { message: "404 Not found" }) : relayed(200, answer);
		};
		return fakeServer(
			{
				"GET /projects/p1": PROJECT,
				"POST /api/features/forge/gitlab/read": relay,
				"POST /api/features/forge/gitlab/write": relay,
				"GET /api/features/forge/gitlab/reviews": { reviews: {} },
			},
			["board.read", "vcs.read", "vcs.write", "vcs.pr.merge"],
		);
	}

	it("lists the merge requests and issues, opens an issue read only and a merge request", async () => {
		gitlab({
			[`GET ${ENC}/merge_requests?state=opened&per_page=50`]: [
				{ iid: 3, title: "Add search", state: "opened", author: { username: "bob" }, source_branch: "feat", target_branch: "main", merge_status: "can_be_merged" },
			],
			[`GET ${ENC}/issues?state=opened&per_page=50`]: [{ iid: 8, title: "Crash", state: "opened", author: { username: "carol" } }],
			[`GET ${ENC}/issues/8`]: { iid: 8, title: "Crash", description: "On login", state: "opened", author: { username: "carol" } },
			[`GET ${ENC}/issues/8/notes?per_page=100`]: [
				{ id: 1, body: "assigned to @bob", system: true },
				{ id: 2, body: "Seen too", author: { username: "dan" } },
			],
			[`GET ${ENC}/merge_requests/3`]: { iid: 3, title: "Add search", description: "", state: "opened", source_branch: "feat", target_branch: "main", merge_status: "cannot_be_merged" },
			[`GET ${ENC}/merge_requests/3/changes`]: { changes: [{ new_path: "src/a.ts", diff: "+x" }, { old_path: "gone.ts" }] },
			[`POST ${ENC}/merge_requests/3/notes`]: {},
		});
		const app = await openApp("/projects/p1/forge");
		expect(await screen.findByText("#3 Add search")).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Merge requests" })).toBeTruthy();
		await fireEvent.press(screen.getByRole("tab", { name: "Issues" }));
		await fireEvent.press(await screen.findByRole("button", { name: /#8 Crash/ }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/forge/issues/8"));
		expect(await screen.findByText("On login")).toBeTruthy();
		// System notes are left out, and GitLab issues take no comment from the phone.
		expect(screen.getByText("Comments (1)")).toBeTruthy();
		expect(screen.queryByText("assigned to @bob")).toBeNull();
		expect(screen.queryByLabelText("Your comment")).toBeNull();
		restoreFetch();

		const second = gitlab({
			[`GET ${ENC}/merge_requests/3`]: { iid: 3, title: "Add search", description: "", state: "opened", source_branch: "feat", target_branch: "main", merge_status: "cannot_be_merged" },
			[`GET ${ENC}/merge_requests/3/changes`]: { changes: [{ new_path: "src/a.ts", diff: "+x" }, { old_path: "gone.ts" }] },
			[`POST ${ENC}/merge_requests/3/notes`]: {},
		});
		await openApp("/projects/p1/forge/pulls/3");
		expect(await screen.findByText("gone.ts")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
		expect(screen.queryByText(/^Checks:/)).toBeNull();
		await fireEvent.changeText(screen.getByLabelText("Your comment"), "LGTM");
		await fireEvent.press(screen.getByRole("button", { name: "Comment" }));
		await waitFor(() =>
			expect(second.called("POST /api/features/forge/gitlab/write")[0]?.body).toEqual({
				method: "POST",
				endpoint: `${ENC}/merge_requests/3/notes`,
				body: { body: "LGTM" },
			}),
		);
	});
});

describe("long texts", () => {
	it("shows a long spec in part until opened, then hides it again", async () => {
		const spec = `# Plan\n${"step ".repeat(400)}END`;
		fakeServer(
			{
				"GET /api/board/cards": { cards: [CARD] },
				"GET /api/board/cards/007-search": { ...CARD, description: "", spec, approval: { approved: true, approvedBy: null }, requireReview: true },
				"GET /projects/p1/specs/spec-7/runs": [],
				"GET /api/board/cards/007-search/steering": { messages: [] },
				"GET /api/board/cards/007-search/logs": { logs: null },
			},
			["board.read"],
		);
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("Approved by ?")).toBeTruthy();
		expect(screen.queryByText(/END$/)).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: "Show the full spec" }));
		expect(screen.getByText(/END$/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Hide the spec" }));
		expect(screen.queryByText(/END$/)).toBeNull();
	});
});
