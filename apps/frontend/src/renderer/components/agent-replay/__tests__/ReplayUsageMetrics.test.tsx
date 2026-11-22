/**
 * How replays are shared (#347): the replay view shows this machine's
 * exports week by week and the share of annotated sessions, and, on a server
 * project, its team links' aggregates; each says where it was counted.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";
import type { ReplayTeamUsage, ReplayUsage } from "../../../../shared/types/replay-share";
import { useProjectStore } from "../../../stores/project-store";
import { useReplayUsageStore } from "../../../stores/replay-usage-store";
import { ReplayUsageMetrics } from "../ReplayUsageMetrics";

const api = {
	getReplayUsage: vi.fn(),
	getReplayTeamUsage: vi.fn(),
};

const kinds = { wpreplay: 0, html: 0, video: 0, team_link: 0 };

const local: ReplayUsage = {
	weeks: [
		{ start: "2026-11-07T10:00:00Z", end: "2026-11-14T10:00:00Z", total: 0, byKind: kinds },
		{ start: "2026-11-14T10:00:00Z", end: "2026-11-21T10:00:00Z", total: 3, byKind: kinds },
	],
	exports: 3,
	exportsPerWeek: 1.5,
	sessions: { total: 4, annotated: 3, discussed: 2, summarized: 1, imported: 0 },
	annotatedRatio: 0.75,
};

const team: ReplayTeamUsage = {
	windowDays: 28,
	weeks: [{ start: "2026-11-14T10:00:00Z", end: "2026-11-21T10:00:00Z", created: 2, opened: 1 }],
	links: 2,
	openedLinks: 1,
	openRate: 0.5,
	opens: 7,
	active: 2,
	annotated: 0,
	annotatedRatio: null,
	sharers: 1,
};

const project = (id: string, remote: boolean) =>
	({
		id,
		name: `Project ${id}`,
		path: `/p/${id}`,
		...(remote ? { remote: { repoUrl: "https://x/y.git", defaultBranch: "main", role: "member" } } : {}),
	}) as unknown as Project;

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useReplayUsageStore.setState({ local: null, team: {}, loading: false, error: null });
	useProjectStore.setState({ projects: [], selectedProjectId: null });
});

afterEach(cleanup);

describe("ReplayUsageMetrics", () => {
	it("shows this machine's figures and says they stay here", async () => {
		useProjectStore.setState({ projects: [project("l", false)], selectedProjectId: "l" });
		api.getReplayUsage.mockResolvedValue({ success: true, usage: local });
		render(<ReplayUsageMetrics />);

		expect(await screen.findByText("How your replays are shared")).toBeInTheDocument();
		expect(screen.getByText("75%")).toBeInTheDocument();
		expect(screen.getByText("1.5")).toBeInTheDocument();
		expect(screen.getByText("Exports, last 2 weeks")).toBeInTheDocument();
		expect(screen.getByTitle("3 exports")).toBeInTheDocument();
		expect(screen.getByText(/Nothing is sent anywhere\./)).toBeInTheDocument();
		// A local project asks no server.
		expect(api.getReplayTeamUsage).not.toHaveBeenCalled();
		expect(screen.queryByText(/Team links of/)).not.toBeInTheDocument();
	});

	it("adds a server project's team figures", async () => {
		useProjectStore.setState({ projects: [project("s", true)], selectedProjectId: "s" });
		api.getReplayUsage.mockResolvedValue({ success: true, usage: local });
		api.getReplayTeamUsage.mockResolvedValue({ success: true, usage: team });
		render(<ReplayUsageMetrics />);

		expect(await screen.findByText("Team links of Project s")).toBeInTheDocument();
		expect(api.getReplayTeamUsage).toHaveBeenCalledWith("s");
		expect(screen.getByText("50%")).toBeInTheDocument();
		expect(screen.getByText("—")).toBeInTheDocument();
		expect(screen.getByText("Links made, last 28 days")).toBeInTheDocument();
		expect(screen.getByTitle("2 links")).toBeInTheDocument();
	});

	it("says what went wrong, and shows nothing before an answer", async () => {
		api.getReplayUsage.mockReturnValue(new Promise(() => undefined));
		const { container } = render(<ReplayUsageMetrics />);
		expect(container).toBeEmptyDOMElement();
		cleanup();

		api.getReplayUsage.mockResolvedValue({ success: false, error: "bad_usage" });
		render(<ReplayUsageMetrics />);
		expect(
			await screen.findByText("The usage figures came back in an unexpected form."),
		).toBeInTheDocument();
	});
});

describe("useReplayUsageStore.load", () => {
	it("keeps the local figures when the server refuses, and says why", async () => {
		api.getReplayUsage.mockResolvedValue({ success: true, usage: local });
		api.getReplayTeamUsage.mockResolvedValue({ success: false, error: "not_a_server_project" });
		await useReplayUsageStore.getState().load("s");
		const state = useReplayUsageStore.getState();
		expect(state.local).toEqual(local);
		expect(state.team).toEqual({});
		expect(state.error?.key).toBe("replay:share.errors.not_a_server_project");
	});

	it("names the local failure first", async () => {
		api.getReplayUsage.mockResolvedValue({ success: false, error: "x", unreachable: true });
		api.getReplayTeamUsage.mockResolvedValue({ success: false, error: "not_a_server_project" });
		await useReplayUsageStore.getState().load("s");
		await waitFor(() =>
			expect(useReplayUsageStore.getState().error?.key).toBe(
				"replay:errors.backendUnreachable",
			),
		);
	});
});
