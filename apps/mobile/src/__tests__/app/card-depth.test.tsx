import { act, fireEvent, screen } from "expo-router/testing-library";
import { AppState } from "react-native";
import type { BoardCard, ChangedFile, LogPhase, TaskLogEntry, TaskPhaseLog } from "../../api/types";
import { MAX_FULL_LOG_LINES } from "../../app/(app)/projects/[projectId]/cards/[cardId]/logs";
import { MAX_FULL_PATCH_LINES } from "../../card/patch";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const CARD_PATH = "/api/board/cards/007-search";
const CARD: BoardCard = {
	id: "007-search",
	title: "Search the catalogue",
	column: "in_progress",
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

function phase(name: LogPhase, status: TaskPhaseLog["status"], entries: TaskLogEntry[]): TaskPhaseLog {
	return { phase: name, status, started_at: null, completed_at: null, entries };
}
const line = (content: string, type = "text", tool_name?: string): TaskLogEntry => ({
	timestamp: "2026-11-27T09:00:00Z",
	type,
	content,
	...(tool_name ? { tool_name } : {}),
});

function serve(routes: Record<string, unknown>) {
	return fakeServer(
		{
			"GET /api/board/cards": { cards: [CARD] },
			[`GET ${CARD_PATH}`]: DETAILS,
			"GET /projects/p1/specs/spec-7/runs": [],
			[`GET ${CARD_PATH}/changes`]: { exists: false, files: [] },
			[`GET ${CARD_PATH}/logs`]: { logs: null },
			[`GET ${CARD_PATH}/steering`]: { messages: [] },
			...routes,
		},
		["board.read", "task.write"],
	);
}

beforeEach(() => {
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
	jest.useRealTimers();
	restoreFetch();
	jest.restoreAllMocks();
});

describe("a card's whole log", () => {
	const LOGS = {
		phases: {
			planning: phase("planning", "completed", [line("Read the spec")]),
			coding: phase("coding", "active", [
				line("Writing the index"),
				line("pnpm test", "tool_start", "Bash"),
				line("Search broke", "error"),
			]),
			validation: phase("validation", "pending", []),
		},
	};

	it("opens from the card, filters the running phase and finds a word", async () => {
		serve({ [`GET ${CARD_PATH}/logs`]: { logs: LOGS } });
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "See the whole log" }));
		expect(await screen.findByText("Writing the index")).toBeTruthy();
		expect(screen.getByText(/An agent works/)).toBeTruthy();
		expect(screen.getByRole("radio", { name: "Coding · running" }).props.accessibilityState.selected).toBe(true);

		await fireEvent.press(screen.getByRole("radio", { name: "Errors" }));
		expect(screen.queryByText("Writing the index")).toBeNull();
		expect(screen.getByText("Search broke")).toBeTruthy();
		await fireEvent.press(screen.getByRole("radio", { name: "Without the tools" }));
		expect(screen.queryByText(/pnpm test/)).toBeNull();
		expect(screen.getByText("Writing the index")).toBeTruthy();
		await fireEvent.press(screen.getByRole("radio", { name: "Everything" }));
		expect(screen.getByText(/\[Bash\] /)).toBeTruthy();

		await fireEvent.changeText(screen.getByLabelText("Find in the log"), "SEARCH  broke");
		expect(screen.queryByText("Writing the index")).toBeNull();
		expect(screen.getByText("Search broke")).toBeTruthy();
		await fireEvent.changeText(screen.getByLabelText("Find in the log"), "nothing like it");
		expect(screen.getByText("No line to show.")).toBeTruthy();

		await fireEvent.press(screen.getByRole("radio", { name: "Planning · done" }));
		await fireEvent.changeText(screen.getByLabelText("Find in the log"), "");
		expect(screen.getByText("Read the spec")).toBeTruthy();
	});

	it("reads the log again while an agent works, and follows its end unless told not to", async () => {
		jest.useFakeTimers();
		let entries = [line("First step")];
		const server = serve({
			[`GET ${CARD_PATH}/logs`]: () => ({
				logs: { phases: { ...LOGS.phases, coding: phase("coding", "active", entries) } },
			}),
		});
		await openApp("/projects/p1/cards/007-search/logs");
		expect(await screen.findByText("First step")).toBeTruthy();
		await fireEvent(screen.getByText("First step"), "contentSizeChange", 320, 900);
		entries = [...entries, line("Second step")];
		await act(async () => {
			jest.advanceTimersByTime(3_000);
		});
		expect(await screen.findByText("Second step")).toBeTruthy();
		expect(server.called(`GET ${CARD_PATH}/logs`).length).toBeGreaterThan(1);

		await fireEvent(screen.getByLabelText("Follow the end"), "valueChange", false);
		await fireEvent(screen.getByText("Second step"), "contentSizeChange", 320, 1200);
		expect(screen.getByLabelText("Follow the end").props.value).toBe(false);
	});

	it("shows the tail of a very long phase, and says when nothing runs", async () => {
		const many = Array.from({ length: MAX_FULL_LOG_LINES + 3 }, (_, i) => line(`line ${i}`));
		serve({
			[`GET ${CARD_PATH}/logs`]: { logs: { phases: { coding: phase("coding", "completed", many) } } },
		});
		await openApp("/projects/p1/cards/007-search/logs");
		expect(await screen.findByText(/3 earlier lines/)).toBeTruthy();
		expect(screen.getByText(/No agent works on this card now/)).toBeTruthy();
	});

	it("opens on planning when no phase wrote yet", async () => {
		serve({
			[`GET ${CARD_PATH}/logs`]: {
				logs: { phases: { planning: phase("planning", "pending", []), coding: phase("coding", "pending", []) } },
			},
		});
		await openApp("/projects/p1/cards/007-search/logs?x=1");
		expect(await screen.findByRole("radio", { name: "Planning · waiting" })).toBeTruthy();
		expect(screen.getByRole("radio", { name: "Planning · waiting" }).props.accessibilityState.selected).toBe(true);
	});

	it("says there is no line when the card has no log yet", async () => {
		serve({});
		await openApp("/projects/p1/cards/007-search/logs");
		expect(await screen.findByText("No line to show.")).toBeTruthy();
		expect(screen.queryByRole("radio", { name: /Planning/ })).toBeNull();
	});
});

describe("a changed file, full screen", () => {
	const FILES: ChangedFile[] = [
		{
			path: "src/search/index.ts",
			status: "modified",
			additions: 2,
			deletions: 1,
			patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,3 +10,4 @@ export\n context one\n-old line\n+new line\n+another\n context two\n\n",
		},
		{ path: "assets/logo.png", status: "added", additions: 0, deletions: 0, patch: null },
		{ path: "docs/old.md", status: "deleted", additions: 0, deletions: 3, patch: "@@ odd hunk\n-gone" },
	];
	const CHANGES = { exists: true, filesChanged: 3, additions: 2, deletions: 4, files: FILES };

	it("opens from the card's changes, numbers the lines, and walks the files", async () => {
		serve({ [`GET ${CARD_PATH}/changes`]: CHANGES });
		await openApp("/projects/p1/cards/007-search");
		await fireEvent.press(await screen.findByRole("button", { name: "Show or hide the changes of src/search/index.ts" }));
		await fireEvent.press(screen.getByRole("button", { name: "See the file full screen" }));
		expect(await screen.findByText("File 1 of 3")).toBeTruthy();
		expect(screen.getByText("Modified")).toBeTruthy();
		expect(screen.getByText("+new line")).toBeTruthy();
		// "context one" is line 10 on both sides; "new line" is the new file's 11.
		expect(screen.getAllByText("10")).toHaveLength(2);
		expect(screen.getAllByText("11").length).toBeGreaterThanOrEqual(2);
		expect(screen.getAllByText("13")).toHaveLength(2);
		expect(screen.getByRole("button", { name: "Previous" }).props.accessibilityState.disabled).toBe(true);

		await fireEvent.press(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText("File 2 of 3")).toBeTruthy();
		expect(screen.getByText("Added")).toBeTruthy();
		expect(screen.getByText(/No diff to show for this file/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText("File 3 of 3")).toBeTruthy();
		expect(screen.getByText("Deleted")).toBeTruthy();
		expect(screen.getByText("-gone")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Next" }).props.accessibilityState.disabled).toBe(true);
		await fireEvent.press(screen.getByRole("button", { name: "Previous" }));
		expect(await screen.findByText("File 2 of 3")).toBeTruthy();
	});

	it("keeps to the files there are, and cuts a very long diff", async () => {
		const long = ["@@ -1 +1 @@", ...Array.from({ length: MAX_FULL_PATCH_LINES + 2 }, (_, i) => `+l${i}`)].join("\n");
		serve({
			[`GET ${CARD_PATH}/changes`]: {
				exists: true,
				files: [{ path: "big.ts", status: "renamed", additions: 9, deletions: 0, patch: long }],
			},
		});
		await openApp("/projects/p1/cards/007-search/files?file=-4");
		expect(await screen.findByText("File 1 of 1")).toBeTruthy();
		restoreFetch();
		serve({
			[`GET ${CARD_PATH}/changes`]: {
				exists: true,
				files: [{ path: "big.ts", status: "renamed", additions: 9, deletions: 0, patch: long }],
			},
		});
		await openApp("/projects/p1/cards/007-search/files?file=9");
		expect(await screen.findByText("File 1 of 1")).toBeTruthy();
		expect(screen.getByText("Renamed")).toBeTruthy();
		expect(screen.getByText(/The diff is cut here/)).toBeTruthy();
	});

	it("opens the first file when the place asked is not a number", async () => {
		serve({ [`GET ${CARD_PATH}/changes`]: CHANGES });
		await openApp("/projects/p1/cards/007-search/files?file=abc");
		expect(await screen.findByText("File 1 of 3")).toBeTruthy();
	});

	it("says when the card changed nothing", async () => {
		serve({});
		await openApp("/projects/p1/cards/007-search/files");
		expect(await screen.findByText("No build workspace yet.")).toBeTruthy();
	});

	it("says so when the changes cannot be read", async () => {
		serve({ [`GET ${CARD_PATH}/changes`]: reply(500, { detail: "down" }) });
		await openApp("/projects/p1/cards/007-search/files");
		expect(await screen.findByText("No build workspace yet.")).toBeTruthy();
	});
});
