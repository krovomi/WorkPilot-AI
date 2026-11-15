/** @vitest-environment jsdom */
/**
 * The Lifecycle tab (#348, #352): the conflicts to resolve side by side, the
 * trash with its Restore and its "purged within 7 days" notice, the journal
 * in words — and the person, not the model, decides.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { MemoryLifecycleView } from "../../../../../shared/types";
import { LifecycleTab } from "../LifecycleTab";

const BASE = "knowledge/projects/shop/memory";

function view(): MemoryLifecycleView {
	return {
		pinned: 2,
		pinLimit: 50,
		retentionDays: 30,
		journal: [
			{
				id: "e1",
				ts: "2026-11-14T10:00:00+00:00",
				action: "forget",
				actor: "user",
				note: `${BASE}/gotchas/old.md`,
				title: "Old advice",
				preview: "Old advice",
				reason_code: "user-request",
				reason: "We changed the queue",
				related: [],
			},
		],
		trash: [
			{
				id: "gotchas/old.md",
				path: `${BASE}/gotchas/old.md`,
				kind: "gotcha",
				title: "Old advice",
				preview: "Old advice",
				forgotten_at: "2026-11-14T10:00:00+00:00",
				forgotten_by: "user",
				reason_code: "user-request",
				reason: "We changed the queue",
				restore_until: "2026-11-18T10:00:00+00:00",
				pinned: false,
				expiring_soon: true,
			},
		],
		conflicts: [
			{
				id: "0123456789abcdef",
				kind: "gotcha",
				signal: "negation",
				detail: "migrations, tests",
				textual: false,
				detected_at: "2026-11-14T10:00:00+00:00",
				a: {
					path: `${BASE}/gotchas/always.md`,
					title: "Always",
					text: "Always run the migrations before the tests.",
					preview: "",
					updated: "2026-11-14T10:00:00+00:00",
					pinned: false,
					confidence: null,
					agents: ["workpilot"],
					tasks: [],
				},
				b: {
					path: `${BASE}/gotchas/never.md`,
					title: "Never",
					text: "Never run the migrations before the tests.",
					preview: "",
					updated: "2026-11-14T10:00:00+00:00",
					pinned: false,
					confidence: 0.8,
					agents: [],
					tasks: [],
				},
			},
		],
	};
}

const api = {
	getMemoryLifecycle: vi.fn(),
	restoreMemory: vi.fn(),
	resolveMemoryConflict: vi.fn(),
	suggestMemoryResolution: vi.fn(),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.getMemoryLifecycle.mockResolvedValue({ success: true, data: view() });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

describe("the Lifecycle tab", () => {
	it("shows both sides of a conflict, the trash notice and the journal", async () => {
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText("Always run the migrations before the tests.")).toBeInTheDocument();
		expect(screen.getByText("Never run the migrations before the tests.")).toBeInTheDocument();
		expect(screen.getByText("One says to do it, the other not to")).toBeInTheDocument();
		expect(screen.getByText(/will be deleted within 7 days/)).toBeInTheDocument();
		expect(screen.getByText(/Forgotten by you — asked by a person/)).toBeInTheDocument();
		expect(screen.getByText("2 / 50 pinned")).toBeInTheDocument();
	});

	it("keeps the side the person picks and reads the view again", async () => {
		api.resolveMemoryConflict.mockResolvedValue({ success: true, data: { canonical: "x" } });
		render(<LifecycleTab projectId="p1" />);
		const [keepA] = await screen.findAllByRole("button", { name: "Keep this one" });
		fireEvent.click(keepA);
		await waitFor(() =>
			expect(api.resolveMemoryConflict).toHaveBeenCalledWith("p1", "0123456789abcdef", "a", ""),
		);
		await waitFor(() => expect(api.getMemoryLifecycle).toHaveBeenCalledTimes(2));
	});

	it("shows the model's opinion as a draft the person still has to save", async () => {
		api.suggestMemoryResolution.mockResolvedValue({
			success: true,
			data: {
				verdict: "contradiction",
				prefer: "b",
				canonical: "Run the migrations in CI only.",
				reason: "B is newer",
			},
		});
		render(<LifecycleTab projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Ask the model" }));
		expect(await screen.findByText(/They contradict each other/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Use as draft" }));
		expect(screen.getByDisplayValue("Run the migrations in CI only.")).toBeInTheDocument();
		expect(api.resolveMemoryConflict).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Save the canonical note" }));
		await waitFor(() =>
			expect(api.resolveMemoryConflict).toHaveBeenCalledWith(
				"p1",
				"0123456789abcdef",
				"custom",
				"Run the migrations in CI only.",
			),
		);
	});

	it("restores a forgotten memory and warns when it contradicts a current one", async () => {
		api.restoreMemory.mockResolvedValue({
			success: true,
			data: { path: `${BASE}/gotchas/old.md`, contradicts: [{ path: "x", signal: "negation", detail: "" }] },
		});
		render(<LifecycleTab projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
		expect(await screen.findByText(/it contradicts 1 current memory/)).toBeInTheDocument();
		expect(api.restoreMemory).toHaveBeenCalledWith("p1", "gotchas/old.md");
	});

	it("reads nothing for a server project", () => {
		render(<LifecycleTab projectId="p1" onServer />);
		expect(screen.getByText(/not available yet/)).toBeInTheDocument();
		expect(api.getMemoryLifecycle).not.toHaveBeenCalled();
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText("L'une dit de le faire, l'autre non")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Garder celle-ci" })).toHaveLength(2);
	});
});

describe("what the tab says when things go wrong or there is nothing", () => {
	function empty(): MemoryLifecycleView {
		return { ...view(), journal: [], trash: [], conflicts: [] };
	}

	it("says there is no conflict, nothing forgotten and no decision yet", async () => {
		api.getMemoryLifecycle.mockResolvedValue({ success: true, data: empty() });
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText("No conflict waiting.")).toBeInTheDocument();
		expect(screen.getByText("Nothing forgotten.")).toBeInTheDocument();
		expect(screen.getByText("No decision recorded yet.")).toBeInTheDocument();
	});

	it("says why the lifecycle could not be read", async () => {
		api.getMemoryLifecycle.mockResolvedValue({ success: false, error: "no-brain" });
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not read the memory's lifecycle: no shared brain yet",
		);
	});

	it("says the action failed when the call throws or names no reason", async () => {
		api.getMemoryLifecycle.mockRejectedValueOnce(new Error("ipc down"));
		const first = render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("the action failed");
		first.unmount();

		api.getMemoryLifecycle.mockResolvedValueOnce({ success: false });
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("the action failed");
	});

	it("names a forgotten memory by its preview when it has no title", async () => {
		const data = view();
		data.trash[0] = { ...data.trash[0], title: "", preview: "Run tests twice" };
		api.getMemoryLifecycle.mockResolvedValue({ success: true, data });
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText("Run tests twice")).toBeInTheDocument();
	});

	it("says a memory was restored, or why it was not", async () => {
		api.restoreMemory.mockResolvedValueOnce({
			success: true,
			data: { path: `${BASE}/gotchas/old.md`, contradicts: [] },
		});
		render(<LifecycleTab projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Memory restored.");

		api.restoreMemory.mockResolvedValueOnce({ success: false, error: "expired" });
		fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("the retention period is over"),
		);
	});
});

describe("ConflictResolver, every way out", () => {
	it("keeps the received side, and marks a pinned side", async () => {
		const data = view();
		data.conflicts[0].a.pinned = true;
		api.getMemoryLifecycle.mockResolvedValue({ success: true, data });
		api.resolveMemoryConflict.mockResolvedValue({ success: true, data: { canonical: null } });
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText("Pinned")).toBeInTheDocument();
		const [, keepB] = screen.getAllByRole("button", { name: "Keep this one" });
		fireEvent.click(keepB);
		await waitFor(() =>
			expect(api.resolveMemoryConflict).toHaveBeenCalledWith("p1", "0123456789abcdef", "b", ""),
		);
	});

	it("writes a canonical note by hand, or puts the pen down", async () => {
		api.resolveMemoryConflict.mockResolvedValue({ success: true, data: { canonical: "x" } });
		render(<LifecycleTab projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Write the canonical note" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("What the team should follow from now on")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Write the canonical note" }));
		fireEvent.change(screen.getByLabelText("What the team should follow from now on"), {
			target: { value: "Run the migrations in CI." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save the canonical note" }));
		await waitFor(() =>
			expect(api.resolveMemoryConflict).toHaveBeenCalledWith(
				"p1",
				"0123456789abcdef",
				"custom",
				"Run the migrations in CI.",
			),
		);
	});

	it("dismisses a false conflict, and says why one was refused", async () => {
		api.resolveMemoryConflict.mockResolvedValueOnce({ success: false, error: "stale" });
		render(<LifecycleTab projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Not a conflict" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("already settled elsewhere");
		expect(api.resolveMemoryConflict).toHaveBeenCalledWith("p1", "0123456789abcdef", "dismiss", "");

		api.resolveMemoryConflict.mockRejectedValueOnce(new Error("ipc down"));
		fireEvent.click(screen.getByRole("button", { name: "Not a conflict" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the action failed"));
	});

	it("says when the model had no answer, or could not be asked", async () => {
		api.suggestMemoryResolution.mockResolvedValueOnce({ success: false, error: "no-answer" });
		render(<LifecycleTab projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Ask the model" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("the model gave no usable answer");

		api.suggestMemoryResolution.mockRejectedValueOnce(new Error("ipc down"));
		fireEvent.click(screen.getByRole("button", { name: "Ask the model" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the action failed"));
	});
});
