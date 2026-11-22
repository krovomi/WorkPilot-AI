/** @vitest-environment jsdom */
/**
 * Taking a decision back and reading the figures (#348): the last automatic
 * decision of the hour has its Undo, a merge its Separate, and the tab says
 * what happened — and when the automations remove too much.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { MemoryLifecycleMetrics, MemoryLifecycleView } from "../../../../../shared/types";
import { LifecycleTab } from "../LifecycleTab";

const BASE = "knowledge/projects/shop/memory";

const METRICS: MemoryLifecycleMetrics = {
	restores_week: 6,
	undone_week: 1,
	automatic_forgets_week: 2,
	live: 8,
	pinned: 2,
	pin_rate: 0.25,
	conflicts_month: 3,
	auto_settled_month: 2,
	resolved_month: 1,
	mean_resolution_hours: 4.5,
	history_views: 7,
	consensus_month: 2,
	consensus_live: 5,
	too_aggressive: true,
};

function view(over: Partial<MemoryLifecycleView> = {}): MemoryLifecycleView {
	return {
		pinned: 2,
		pinLimit: 50,
		retentionDays: 30,
		signers: [],
		signersRejected: 0,
		signing: false,
		canEditSigners: true,
		unverified: [],
		trash: [],
		conflicts: [],
		journal: [
			{
				id: "aaaaaaaaaaaa",
				ts: "2026-11-14T10:00:00+00:00",
				action: "archive",
				actor: "sync",
				note: `${BASE}/gotchas/never.md`,
				title: "Never",
				preview: "",
				reason_code: "pinned-wins",
				reason: "",
				related: [],
			},
			{
				id: "bbbbbbbbbbbb",
				ts: "2026-11-13T10:00:00+00:00",
				action: "archive",
				actor: "user",
				note: `${BASE}/gotchas/old.md`,
				title: "Old",
				preview: "",
				reason_code: "person-chose",
				reason: "",
				related: [],
			},
		],
		revertible: { aaaaaaaaaaaa: "undo", bbbbbbbbbbbb: "unmerge" },
		lastUndo: "aaaaaaaaaaaa",
		maintainers: [],
		maintainerScopes: {},
		canArbitrate: true,
		metrics: METRICS,
		...over,
	};
}

const api = {
	getMemoryLifecycle: vi.fn(),
	revertMemoryDecision: vi.fn(),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.getMemoryLifecycle.mockResolvedValue({ success: true, data: view() });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

describe("taking a decision back", () => {
	it("offers to undo the last automatic decision and queues the pair again", async () => {
		api.revertMemoryDecision.mockResolvedValue({
			success: true,
			data: { mode: "undo", restored: ["x"], conflict: "0123456789abcdef" },
		});
		render(<LifecycleTab projectId="p1" />);
		const banner = await screen.findByTestId("memory-last-undo");
		expect(banner).toHaveTextContent("Archived by the sync — the pinned version wins");
		fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]);
		await waitFor(() => expect(api.revertMemoryDecision).toHaveBeenCalledWith("p1", "aaaaaaaaaaaa"));
		expect(await screen.findByText(/waiting for you under “To resolve”/)).toBeInTheDocument();
		await waitFor(() => expect(api.getMemoryLifecycle).toHaveBeenCalledTimes(2));
	});

	it("separates a merge from the journal, and says when it could not", async () => {
		api.revertMemoryDecision.mockResolvedValueOnce({
			success: true,
			data: { mode: "unmerge", restored: ["x"], conflict: null },
		});
		render(<LifecycleTab projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Separate" }));
		expect(await screen.findByText("Decision taken back.")).toBeInTheDocument();
		expect(api.revertMemoryDecision).toHaveBeenCalledWith("p1", "bbbbbbbbbbbb");

		api.revertMemoryDecision.mockResolvedValueOnce({ success: false, error: "not-revertible" });
		fireEvent.click(screen.getByRole("button", { name: "Separate" }));
		expect(
			await screen.findByText("this decision can no longer be taken back"),
		).toBeInTheDocument();
	});

	it("shows no banner and no button when nothing can be taken back", async () => {
		api.getMemoryLifecycle.mockResolvedValue({
			success: true,
			data: view({ revertible: {}, lastUndo: null, metrics: null }),
		});
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText(/Archived by the sync/)).toBeInTheDocument();
		expect(screen.queryByTestId("memory-last-undo")).toBeNull();
		expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
		expect(screen.queryByTestId("memory-lifecycle-metrics")).toBeNull();
	});
});

describe("the figures", () => {
	it("says how the lifecycle behaves, and warns when it removes too much", async () => {
		render(<LifecycleTab projectId="p1" />);
		const card = await screen.findByTestId("memory-lifecycle-metrics");
		expect(card).toHaveTextContent("6 memories restored this week");
		expect(card).toHaveTextContent("25 % pinned (2 of 8)");
		expect(card).toHaveTextContent("3 conflicts in 30 days: 2 settled by the rules, 1 by a person");
		expect(card).toHaveTextContent("4.5 h on average before a person decides");
		expect(card).toHaveTextContent("7 histories opened on this computer");
		expect(card).toHaveTextContent("2 consensus notes written in 30 days, 5 still in use");
		expect(card).toHaveTextContent(/automatic removals may be too aggressive/);
	});

	it("leaves out the waiting time when no pair was resolved, in French", async () => {
		await i18n.changeLanguage("fr");
		api.getMemoryLifecycle.mockResolvedValue({
			success: true,
			data: view({
				metrics: {
					...METRICS,
					mean_resolution_hours: null,
					too_aggressive: false,
					// An older backend: no consensus figures.
					consensus_month: undefined,
					consensus_live: undefined,
				},
			}),
		});
		render(<LifecycleTab projectId="p1" />);
		const card = await screen.findByTestId("memory-lifecycle-metrics");
		expect(card).toHaveTextContent("Comportement du cycle de vie");
		expect(card).not.toHaveTextContent("en moyenne");
		expect(card).not.toHaveTextContent("trop agressifs");
		expect(card).toHaveTextContent("0 notes de consensus écrites en 30 jours, 0 toujours en usage");
	});
});
