/**
 * The repo bench view: the table, the cards a run can take (and why the
 * others cannot), the engines, and a start that names cards and engines only.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchCandidate, BenchStatus } from "../../../../shared/types";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : key,
		i18n: { language: "en" },
	}),
}));
vi.mock("../../../hooks/useConfiguredProviders", () => ({
	useConfiguredProviders: () => ({ providers: [{ name: "anthropic", label: "Anthropic" }] }),
}));
vi.mock("../../../stores/settings-store", () => ({
	useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: {} }),
}));
vi.mock("../../../../shared/utils/task-engine", () => ({
	defaultEngineProvider: () => "anthropic",
	seedEngine: () => ({
		coding: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
	}),
}));
vi.mock("../../task-engine/EngineTrioPicker", () => ({
	EngineTrioPicker: ({ value }: { value: { model: string } }) => (
		<div data-testid="engine">{value.model}</div>
	),
}));

import { setupBenchListeners, useBenchStore } from "../../../stores/bench-store";
import { RepoBenchView } from "../RepoBenchView";

const STATUS: BenchStatus = {
	activeRunId: null,
	running: [],
	queued: 0,
	concurrency: 2,
	runs: [],
	table: [
		{
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			effort: "medium",
			judged: 4,
			resolved: 3,
			rate: 0.75,
			cases: 4,
			runs: 1,
			f2pRate: 0.8,
			avgCostUsd: 1.234,
			avgDurationS: 600,
		},
	],
};

const CANDIDATES: BenchCandidate[] = [
	{
		specId: "001-a",
		title: "Add mul",
		case: { caseId: "001-a", status: "candidate", source: "merge", runnable: ["t.py"] },
	},
	{
		specId: "002-b",
		title: "Write docs",
		case: { caseId: "002-b", status: "refused", reasonCode: "no-judge", reason: "no test" },
	},
	{
		specId: "003-c",
		title: "Squashed card",
		case: { caseId: "003-c", status: "refused", reasonCode: "no-target", reason: "x" },
	},
];

const api = {
	getBenchStatus: vi.fn(),
	getBenchCandidates: vi.fn(),
	startBench: vi.fn(),
	discardBench: vi.fn(),
	onBenchEvent: vi.fn(
		(_listener: (projectId: string, status: BenchStatus) => void) => () => undefined,
	),
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.onBenchEvent.mockImplementation(() => () => undefined);
	api.getBenchStatus.mockResolvedValue({ success: true, data: STATUS });
	api.getBenchCandidates.mockResolvedValue({ success: true, data: CANDIDATES });
	api.startBench.mockResolvedValue({ success: true, data: { ...STATUS, activeRunId: "r" } });
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useBenchStore.setState({ statusByProject: {} });
});

describe("RepoBenchView", () => {
	it("shows the measured table", async () => {
		render(<RepoBenchView projectId="p1" />);
		expect(await screen.findByText("75 %")).toBeInTheDocument();
		expect(screen.getByText("80 %")).toBeInTheDocument();
		expect(screen.getByText("$1.23")).toBeInTheDocument();
		expect(screen.getByText("10 min")).toBeInTheDocument();
	});

	it("offers only cards that can be judged, and says why the others cannot", async () => {
		render(<RepoBenchView projectId="p1" />);
		await screen.findByText("Add mul");
		const boxes = screen.getAllByRole("checkbox");
		expect(boxes[0]).toBeEnabled();
		expect(boxes[1]).toBeDisabled();
		expect(screen.getByText("reasons.no-judge")).toBeInTheDocument();
		// A card whose landing commit was not found becomes selectable once given one.
		expect(boxes[2]).toBeDisabled();
		await userEvent.type(screen.getByRole("textbox"), "abcdef1");
		expect(screen.getAllByRole("checkbox")[2]).toBeEnabled();
	});

	it("starts with card ids, engines and the commits given, nothing else", async () => {
		render(<RepoBenchView projectId="p1" />);
		await screen.findByText("Add mul");
		await userEvent.type(screen.getByRole("textbox"), "ABCDEF1");
		const boxes = screen.getAllByRole("checkbox");
		await userEvent.click(boxes[0]);
		await userEvent.click(boxes[2]);
		await userEvent.click(screen.getByRole("button", { name: "bench:new.start" }));
		await waitFor(() => expect(api.startBench).toHaveBeenCalled());
		expect(api.startBench).toHaveBeenCalledWith(
			"p1",
			["001-a", "003-c"],
			[{ provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" }],
			{ "003-c": "ABCDEF1" },
		);
	});

	it("shows an event that arrived while the page was closed", async () => {
		let emit: (projectId: string, status: BenchStatus) => void = () => undefined;
		api.onBenchEvent.mockImplementation((listener) => {
			emit = listener;
			return () => undefined;
		});
		api.getBenchStatus.mockReturnValue(new Promise(() => undefined));
		const teardown = setupBenchListeners();
		emit("p1", { ...STATUS, queued: 7, activeRunId: "r" });
		emit("p2", { ...STATUS, table: [] });
		render(<RepoBenchView projectId="p1" />);
		expect(await screen.findByText("75 %")).toBeInTheDocument();
		expect(useBenchStore.getState().statusByProject.p1.queued).toBe(7);
		expect(api.onBenchEvent).toHaveBeenCalledTimes(1);
		teardown();
	});

	it("says it needs a project", () => {
		render(<RepoBenchView />);
		expect(screen.getByText("bench:noProject")).toBeInTheDocument();
		expect(api.getBenchStatus).not.toHaveBeenCalled();
	});
});
