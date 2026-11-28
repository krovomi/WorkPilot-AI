import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import type { InterruptedRun } from "../../interrupted/types";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const LIST = "GET /users/me/interrupted-runs";
const LATER = "POST /users/me/interrupted-runs/later";

function run(extra: Partial<InterruptedRun> = {}): InterruptedRun {
	return {
		run_id: "run-1",
		spec_id: "spec-1",
		card_id: "001-passkey",
		project_id: "p1",
		project_name: "Team site",
		title: "Sign in with a passkey",
		run_phase: "build",
		phase: "coding",
		subtasks_done: 1,
		subtasks_total: 3,
		next_subtask: "Ask for the key",
		model: "a-model",
		interrupted_at: new Date(Date.now() - 14 * 60_000).toISOString(),
		mine: true,
		started_by_name: null,
		blocker: null,
		...extra,
	};
}

const RUNS = [
	run(),
	run({
		run_id: "run-2",
		spec_id: "spec-2",
		card_id: "002-export",
		title: "Export to CSV",
		phase: "planning",
		subtasks_total: 0,
		model: null,
		interrupted_at: null,
		mine: false,
		started_by_name: "Bob",
	}),
	run({ run_id: "run-3", spec_id: "spec-3", title: "Gone card", phase: "spec", blocker: "spec_missing" }),
];

function resumePath(r: InterruptedRun): string {
	return `POST /projects/${r.project_id}/specs/${r.spec_id}/runs/${r.run_id}/resume`;
}

afterEach(() => {
	restoreFetch();
});

describe("the runs the team server stopped", () => {
	it("are offered at start, the person's own ticked, and resumed from where they stopped", async () => {
		const server = fakeServer({
			"GET /projects": [],
			[LIST]: { runs: RUNS },
			[resumePath(RUNS[0])]: { id: "run-9", status: "queued" },
			[LATER]: (c: Call) => ({ set_aside: (c.body as { run_ids: string[] }).run_ids }),
		});
		await openApp("/");
		expect(await screen.findByText("3 tasks were interrupted")).toBeTruthy();
		expect(screen.getByText("1 of 3 selected")).toBeTruthy();
		expect(screen.getByText("Code 1/3")).toBeTruthy();
		expect(screen.getByText("Resumes at “Ask for the key”, with the work already on disk.")).toBeTruthy();
		expect(screen.getAllByText("Server restarted · 14 min ago")).toHaveLength(2);
		expect(screen.getByText("Server restarted")).toBeTruthy();
		expect(screen.getByText("Started by Bob: unticked, it is their run.")).toBeTruthy();
		expect(screen.getByText("Resumes the planning.")).toBeTruthy();
		expect(screen.getByText("Its card folder is gone: it cannot be resumed.")).toBeTruthy();
		expect(screen.getByRole("checkbox", { name: "Export to CSV" }).props.accessibilityState).toEqual({ checked: false });

		await fireEvent.press(screen.getByRole("button", { name: "Resume (1)" }));
		await waitFor(() => expect(screen.queryByText("3 tasks were interrupted")).toBeNull());
		expect(server.called(resumePath(RUNS[0]))).toHaveLength(1);
		// The rest is set aside on the server, so the desktop does not ask either.
		expect(server.called(LATER).map((c) => c.body)).toEqual([{ run_ids: ["run-2", "run-3"] }]);
	});

	it("ticks and unticks a run, and « Later » sets every run aside", async () => {
		const server = fakeServer({ "GET /projects": [], [LIST]: { runs: RUNS.slice(0, 2) }, [LATER]: { set_aside: [] } });
		await openApp("/");
		await fireEvent.press(await screen.findByRole("checkbox", { name: "Export to CSV" }));
		expect(screen.getByText("2 of 2 selected")).toBeTruthy();
		await fireEvent.press(screen.getByRole("checkbox", { name: "Sign in with a passkey" }));
		await fireEvent.press(screen.getByRole("checkbox", { name: "Export to CSV" }));
		expect(screen.getByText("0 of 2 selected")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Resume (0)" }).props.accessibilityState.disabled).toBe(true);

		await fireEvent.press(screen.getByRole("button", { name: "Later" }));
		await waitFor(() => expect(screen.queryByText("2 tasks were interrupted")).toBeNull());
		expect(server.called(LATER).map((c) => c.body)).toEqual([{ run_ids: ["run-1", "run-2"] }]);
		expect(server.calls.filter((c) => c.path.endsWith("/resume"))).toEqual([]);
	});

	it("keeps a run the server refused, with its reason, and closing sets it aside", async () => {
		const server = fakeServer({
			"GET /projects": [],
			[LIST]: { runs: [run(), run({ run_id: "run-4", spec_id: "spec-4", title: "Second" })] },
			[resumePath(run())]: reply(409, { detail: "This run is no longer waiting to be resumed" }),
			[resumePath(run({ run_id: "run-4", spec_id: "spec-4" }))]: { id: "run-10" },
			// The server cannot take the answer: the prompt still closes.
			[LATER]: reply(500, { detail: "down" }),
		});
		await openApp("/");
		await fireEvent.press(await screen.findByRole("button", { name: "Resume (2)" }));
		expect(await screen.findByText(/no longer waiting to be resumed/)).toBeTruthy();
		expect(screen.getByText("1 task was interrupted")).toBeTruthy();
		expect(server.called(LATER)).toEqual([]);

		await fireEvent(screen.getByTestId("interrupted-runs"), "requestClose");
		await waitFor(() => expect(screen.queryByText("1 task was interrupted")).toBeNull());
		expect(server.called(LATER).map((c) => c.body)).toEqual([{ run_ids: ["run-1"] }]);
	});

	it("asks nothing when nothing was interrupted, or the server cannot say", async () => {
		const server = fakeServer({ "GET /projects": [], [LIST]: { runs: [] } });
		await openApp("/");
		expect(await screen.findByText(/No project yet/)).toBeTruthy();
		await waitFor(() => expect(server.called(LIST)).toHaveLength(1));
		expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
	});
});
