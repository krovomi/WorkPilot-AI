import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AppState, Linking } from "react-native";
import type { BoardCard } from "../../api/types";
import {
	canAnswerReview,
	hasCaptures,
	replacedKinds,
	screenName,
	sideStatusKey,
	stateKey,
	syncReasonKey,
} from "../../captures/describe";
import type { CaptureSide, CardCaptures } from "../../captures/types";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const CARD_PATH = "/api/board/cards/007-search";
const CARD: BoardCard = {
	id: "007-search",
	title: "Search the catalogue",
	column: "human_review",
	kind: "feature",
	updatedAt: null,
	subtasks: { completed: 0, total: 0 },
	specId: "spec-7",
	claimedBy: null,
	claimedByName: null,
};
const DETAILS = {
	...CARD,
	description: "Full-text search",
	spec: null,
	approval: { approved: true, approvedBy: null, approvedAt: null },
	requireReview: true,
};

const side = (over: Partial<CaptureSide> = {}): CaptureSide => ({
	available: true,
	status: "pseudonymized",
	replaced: 2,
	kinds: ["email", "phone"],
	passes: ["page"],
	...over,
});

function captures(over: Partial<CardCaptures> = {}): CardCaptures {
	return {
		needed: true,
		reason: "ui-files",
		items: [
			{
				key: "web|/search|desktop|en",
				label: "Search",
				platform: "web",
				variant: "desktop",
				route: "search",
				locale: "en",
				before: side({ kinds: ["iban"] }),
				after: side(),
				publishable: true,
			},
			{
				key: "web|/account|desktop|en",
				label: "",
				platform: "web",
				variant: "desktop",
				route: "account",
				locale: "en",
				before: null,
				after: side({ available: false, status: "withheld", kinds: [] }),
				publishable: false,
			},
		],
		publishable: 1,
		withheld: 1,
		publish: "auto",
		protect: true,
		approved: false,
		sync: {
			status: "published",
			reason: "",
			hosted: 2,
			syncedAt: "2026-11-28T16:01:00+00:00",
			prUrl: "https://github.com/acme/shop/pull/7",
		},
		...over,
	};
}

const IMAGE = { mimeType: "image/png", data: "iVBORw0KGgo=" };

function serve(routes: Record<string, unknown>, permissions = ["board.read", "task.read"]) {
	return fakeServer(
		{
			"GET /api/board/cards": { cards: [CARD] },
			[`GET ${CARD_PATH}`]: DETAILS,
			"GET /projects/p1/specs/spec-7/runs": [],
			[`GET ${CARD_PATH}/changes`]: { exists: false, files: [] },
			[`GET ${CARD_PATH}/logs`]: { logs: null },
			[`GET ${CARD_PATH}/steering`]: { messages: [] },
			[`GET ${CARD_PATH}/captures/0/before`]: IMAGE,
			[`GET ${CARD_PATH}/captures/0/after`]: IMAGE,
			...routes,
		},
		permissions,
	);
}

beforeEach(() => {
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("what the phone says about captures", () => {
	it("says where the captures stand with the pull request", () => {
		const synced = captures().sync as NonNullable<CardCaptures["sync"]>;
		expect(stateKey(captures())).toBe("captures.state_inPr");
		expect(stateKey(captures({ needed: false }))).toBe("captures.state_notNeeded");
		expect(stateKey(captures({ publish: "never" }))).toBe("captures.state_off");
		expect(stateKey(captures({ publishable: 0 }))).toBe("captures.state_noneToShow");
		expect(stateKey(captures({ publish: "review" }))).toBe("captures.state_waitingReview");
		expect(stateKey(captures({ sync: null }))).toBe("captures.state_noPr");
		expect(stateKey(captures({ sync: { ...synced, status: "failed", reason: "no-credentials" } }))).toBe(
			"captures.state_syncFailed",
		);
		expect(stateKey(captures({ sync: { ...synced, status: "nothing" } }))).toBe("captures.state_ready");
	});

	it("names a reason it knows, and a generic one otherwise", () => {
		expect(syncReasonKey("pr-write-failed")).toBe("captures.reason_pr_write_failed");
		expect(syncReasonKey("something-new")).toBe("captures.reason_other");
	});

	it("names a screen and the kinds replaced on both sides", () => {
		const [first, second] = captures().items;
		expect(screenName(first)).toBe("Search");
		expect(screenName(second)).toBe("/account");
		expect(screenName({ ...second, route: "", platform: "android" })).toBe("android");
		expect(screenName({ ...second, route: "", platform: "" })).toBe("?");
		expect(replacedKinds(first)).toEqual(["email", "iban", "phone"]);
		expect(replacedKinds({ ...first, before: null, after: null })).toEqual([]);
	});

	it("says a side's status, an unknown one as not available", () => {
		expect(sideStatusKey(side())).toBe("captures.status_pseudonymized");
		expect(sideStatusKey(side({ status: "something-new" }))).toBe("captures.status_failed");
	});

	it("shows a section only for a card with a publication", () => {
		expect(hasCaptures(null)).toBe(false);
		expect(hasCaptures(captures({ needed: false, items: [] }))).toBe(false);
		expect(hasCaptures(captures({ needed: false }))).toBe(true);
		expect(hasCaptures(captures({ items: [] }))).toBe(true);
	});

	it("offers a review's answer only in review mode with something to publish", () => {
		expect(canAnswerReview(captures({ publish: "review" }))).toBe(true);
		expect(canAnswerReview(captures())).toBe(false);
		expect(canAnswerReview(captures({ publish: "review", publishable: 0 }))).toBe(false);
		expect(canAnswerReview(captures({ publish: "review", needed: false }))).toBe(false);
	});
});

describe("a card's captures", () => {
	it("has no section when the server has no captures for the card", async () => {
		serve({});
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText("Search the catalogue")).toBeTruthy();
		expect(screen.queryByText("See the captures")).toBeNull();
	});

	it("opens from the card and shows each screen before and after, fakes said", async () => {
		const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
		const server = serve({ [`GET ${CARD_PATH}/captures`]: { captures: captures() } });
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText(/2 screens · 1 kept on the task/)).toBeTruthy();
		expect(screen.getByText("Shown in the pull request.")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "See the captures" }));

		expect(await screen.findByText("Search")).toBeTruthy();
		expect(screen.getByText("/account")).toBeTruthy();
		expect(screen.getByText("Replaced by fakes: email, IBAN, phone")).toBeTruthy();
		expect(await screen.findAllByLabelText(/^Capture, /)).toHaveLength(2);
		expect(screen.getByText("Not shown: this copy stays on the task.")).toBeTruthy();
		expect(screen.getByText("No capture of the base branch.")).toBeTruthy();
		expect(screen.getByText(/1 screen stays on the task/)).toBeTruthy();
		// A copy kept on the task is never asked for.
		expect(server.called(`GET ${CARD_PATH}/captures/1/after`)).toHaveLength(0);
		// No Publish button outside review mode.
		expect(screen.queryByRole("button", { name: "Publish in the pull request" })).toBeNull();

		await fireEvent.press(screen.getByRole("button", { name: "Open the pull request" }));
		expect(open).toHaveBeenCalledWith("https://github.com/acme/shop/pull/7");
	});

	it("lets a reviewer publish, then starts the run that updates the pull request", async () => {
		let approved = false;
		const server = serve(
			{
				[`GET ${CARD_PATH}/captures`]: () => ({ captures: captures({ publish: "review", approved, sync: null }) }),
				[`POST ${CARD_PATH}/captures/publish`]: () => {
					approved = true;
					return { captures: captures({ publish: "review", approved, sync: null }) };
				},
				"POST /projects/p1/specs/spec-7/runs": { id: "r1", spec_id: "spec-7", phase: "captures", status: "queued" },
			},
			["board.read", "task.read", "review.approve", "agent.execute", "vcs.pr.create"],
		);
		await openApp("/projects/p1/cards/007-search/captures?specId=spec-7");
		expect(await screen.findByText("Waiting for a reviewer to publish them.")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Publish in the pull request" }));
		expect(await screen.findByText("The server is updating the pull request.")).toBeTruthy();
		expect(server.called(`POST ${CARD_PATH}/captures/publish`)).toHaveLength(1);
		expect(server.called("POST /projects/p1/specs/spec-7/runs")[0].body).toEqual({ phase: "captures" });
		expect(screen.getByRole("button", { name: "Withdraw from the pull request" })).toBeTruthy();
	});

	it("records a publish without starting a run for someone who may not edit the pull request", async () => {
		const server = serve(
			{
				[`GET ${CARD_PATH}/captures`]: { captures: captures({ publish: "review" }) },
				[`POST ${CARD_PATH}/captures/publish`]: { captures: captures({ publish: "review", approved: true }) },
			},
			["board.read", "task.read", "review.approve"],
		);
		await openApp("/projects/p1/cards/007-search/captures?specId=spec-7");
		await fireEvent.press(await screen.findByRole("button", { name: "Publish in the pull request" }));
		expect(await screen.findByText(/updated at its next sync/)).toBeTruthy();
		expect(server.called("POST /projects/p1/specs/spec-7/runs")).toHaveLength(0);
	});

	it("hides the review's answer from someone who may not approve", async () => {
		serve({ [`GET ${CARD_PATH}/captures`]: { captures: captures({ publish: "review" }) } });
		await openApp("/projects/p1/cards/007-search/captures?specId=spec-7");
		expect(await screen.findByText("Waiting for a reviewer to publish them.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Publish in the pull request" })).toBeNull();
	});

	it("says why the pull request could not be updated, and drops a link that is not https", async () => {
		serve({
			[`GET ${CARD_PATH}/captures`]: {
				captures: captures({
					sync: { status: "failed", reason: "no-credentials", hosted: 0, syncedAt: "", prUrl: "http://x/pull/1" },
				}),
			},
		});
		await openApp("/projects/p1/cards/007-search/captures");
		expect(await screen.findByText("No forge sign-in on the server for this project.")).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("button", { name: "Open the pull request" })).toBeNull());
	});

	it("lets a reviewer withdraw published captures, the run left to the next sync without a card id", async () => {
		let approved = true;
		const server = serve(
			{
				[`GET ${CARD_PATH}/captures`]: () => ({ captures: captures({ publish: "review", approved }) }),
				[`POST ${CARD_PATH}/captures/withdraw`]: () => {
					approved = false;
					return { captures: captures({ publish: "review", approved }) };
				},
			},
			["board.read", "task.read", "review.approve", "agent.execute", "vcs.pr.create"],
		);
		await openApp("/projects/p1/cards/007-search/captures");
		await fireEvent.press(await screen.findByRole("button", { name: "Withdraw from the pull request" }));
		expect(await screen.findByText(/updated at its next sync/)).toBeTruthy();
		expect(server.called(`POST ${CARD_PATH}/captures/withdraw`)).toHaveLength(1);
		expect(server.calls.some((c) => c.path.endsWith("/runs") && c.method === "POST")).toBe(false);
		expect(screen.getByRole("button", { name: "Publish in the pull request" })).toBeTruthy();
	});

	it("says why a publish was refused", async () => {
		serve(
			{
				[`GET ${CARD_PATH}/captures`]: { captures: captures({ publish: "review" }) },
				[`POST ${CARD_PATH}/captures/publish`]: reply(409, { detail: "No capture to publish" }),
			},
			["board.read", "task.read", "review.approve"],
		);
		await openApp("/projects/p1/cards/007-search/captures?specId=spec-7");
		await fireEvent.press(await screen.findByRole("button", { name: "Publish in the pull request" }));
		expect(await screen.findByText(/No capture to publish/)).toBeTruthy();
	});

	it("says when an image cannot be loaded, and fits an image to its size", async () => {
		serve({
			[`GET ${CARD_PATH}/captures`]: { captures: captures() },
			[`GET ${CARD_PATH}/captures/0/before`]: reply(404, { detail: "Capture not found" }),
		});
		await openApp("/projects/p1/cards/007-search/captures");
		expect(await screen.findByText("The image could not be loaded.")).toBeTruthy();
		const image = await screen.findByLabelText("Capture, After");
		await fireEvent(image, "load", { nativeEvent: { source: { width: 0, height: 0 } } });
		await fireEvent(image, "load", { nativeEvent: { source: { width: 400, height: 200 } } });
		expect(screen.getByLabelText("Capture, After").props.style).toEqual(
			expect.arrayContaining([expect.objectContaining({ aspectRatio: 2 })]),
		);
	});

	it("shows a phone screen, an unknown kind as it is, and a team that publishes without fakes", async () => {
		const phone = {
			...captures().items[0],
			key: "",
			label: "",
			route: "",
			platform: "android",
			variant: "mobile",
			locale: "",
			before: null,
			after: side({ kinds: ["ssn"] }),
		};
		serve({
			[`GET ${CARD_PATH}/captures`]: {
				captures: captures({
					items: [phone, { ...phone, key: "other", label: "Other", platform: "", variant: "", after: null }],
					withheld: 0,
					protect: false,
					sync: { status: "nothing", reason: "", hosted: 0, syncedAt: "", prUrl: "" },
				}),
			},
		});
		await openApp("/projects/p1/cards/007-search/captures");
		expect(await screen.findAllByText("android")).toHaveLength(2);
		expect(screen.getByText("phone view")).toBeTruthy();
		expect(screen.getByText("Replaced by fakes: ssn")).toBeTruthy();
		expect(screen.getByText(/without replacing personal data/)).toBeTruthy();
		expect(screen.queryByText(/Last update/)).toBeNull();
		expect(screen.getByText("No capture of the task.")).toBeTruthy();
	});

	it("says there is nothing to show, and when the server could not answer", async () => {
		serve({ [`GET ${CARD_PATH}/captures`]: { captures: captures({ items: [], needed: false }) } });
		await openApp("/projects/p1/cards/007-search/captures");
		expect(await screen.findByText("This task changed no screen: no capture.")).toBeTruthy();
	});

	it("says nothing is there when the server has no captures route", async () => {
		serve({});
		await openApp("/projects/p1/cards/007-search/captures");
		expect(await screen.findByText("This task changed no screen: no capture.")).toBeTruthy();
	});

	it("tells on the card a team that publishes without fakes", async () => {
		serve({ [`GET ${CARD_PATH}/captures`]: { captures: captures({ protect: false, withheld: 0 }) } });
		await openApp("/projects/p1/cards/007-search");
		expect(await screen.findByText(/without replacing personal data/)).toBeTruthy();
		expect(screen.queryByText(/kept on the task/)).toBeNull();
	});

	it("opens the captures of a card the server has not indexed yet", async () => {
		serve({
			"GET /api/board/cards": { cards: [{ ...CARD, specId: null }] },
			[`GET ${CARD_PATH}/captures`]: { captures: captures() },
		});
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "See the captures" }));
		expect(await screen.findByText("Search")).toBeTruthy();
	});
});
