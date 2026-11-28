/**
 * "How you compare": the project's figures against its past and its peers;
 * the person's own projects listed on this computer only, and a group's
 * median hidden below the group size.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildComparison } from "@shared/types/build-compare";
import { formatMetric, trendTone } from "../compare-format";
import { sparklinePoints } from "../CompareSparkline";
import { HowYouCompare } from "../HowYouCompare";

const getBuildComparison = vi.fn();
const getServerBuildComparison = vi.fn();
const exportBuildComparison = vi.fn();

const week = (specs: number, minutes: number | null) => ({
	specs,
	minutes,
	cost: minutes === null ? null : minutes / 10,
	qa_iterations: null,
	agents: null, mutation_score: null, ci_first_pass: null,
});

const comparison: BuildComparison = {
	window_days: 30,
	min_group: 2,
	min_top: 10,
	segment: { stack: "csharp", size: "medium", team: "small", size_from: null, team_from: null },
	recent: { specs: 2, minutes: 40, cost: 1.5, qa_iterations: 1, agents: 3, mutation_score: null, ci_first_pass: null },
	previous: { specs: 1, minutes: 80, cost: 3, qa_iterations: null, agents: 3, mutation_score: null, ci_first_pass: null },
	trend: { minutes: -50, cost: -50, qa_iterations: null, agents: 10, mutation_score: null, ci_first_pass: null },
	weeks: [week(0, null), week(1, 30), week(0, null), week(1, 50)],
	groups: {
		segment: { projects: 1, medians: null, top: null, trend: null },
		stack: { projects: 2, medians: { minutes: 90, cost: 1, qa_iterations: null, agents: 2, mutation_score: null, ci_first_pass: null }, top: null, trend: null },
		team: { projects: 2, medians: { minutes: 25, cost: 0.9, qa_iterations: null, agents: 2, mutation_score: null, ci_first_pass: null }, top: null, trend: null },
		all: {
			projects: 12,
			medians: { minutes: 35, cost: 1.2, qa_iterations: 2, agents: 2, mutation_score: null, ci_first_pass: null },
			top: { minutes: 12, cost: 0.4, qa_iterations: null, agents: 1, mutation_score: null, ci_first_pass: null },
			trend: null,
		},
	},
	kinds: [
		{
			kind: "bug_fix",
			specs: 2,
			minutes: 20,
			cost: 0.5,
			qa_iterations: 1,
			agents: 2, mutation_score: null, ci_first_pass: null,
			group: { projects: 3, medians: { minutes: 45, cost: 0.75, qa_iterations: null, agents: 2, mutation_score: null, ci_first_pass: null }, top: null, trend: null },
		},
		{
			kind: "upgrade",
			specs: 1,
			minutes: 70,
			cost: 2,
			qa_iterations: null,
			agents: 3, mutation_score: null, ci_first_pass: null,
			group: { projects: 1, medians: null, top: null, trend: null },
		},
	],
	projects: [
		{ name: "Shop", stack: "csharp", size: "medium", team: "small", specs: 2, minutes: 40, cost: 1.5, qa_iterations: 1, agents: 3, mutation_score: null, ci_first_pass: null, current: true },
		{ name: "Side project", stack: "other", size: "unknown", team: "solo", specs: 1, minutes: 10, cost: 0.2, qa_iterations: null, agents: 1, mutation_score: null, ci_first_pass: null, current: false },
	],
};

const groupTrend = (values: Partial<BuildComparison["trend"]>): BuildComparison["trend"] => ({
	minutes: null,
	cost: null,
	qa_iterations: null,
	agents: null,
	mutation_score: null,
	ci_first_pass: null,
	...values,
});

/** A project that grew and changed team, with its pace against its peers. */
const moving: BuildComparison = {
	...comparison,
	segment: { ...comparison.segment, size_from: "small", team_from: "solo" },
	recent: { ...comparison.recent, mutation_score: 80, ci_first_pass: 50 },
	trend: { ...comparison.trend, mutation_score: 20, ci_first_pass: 1 },
	groups: {
		...comparison.groups,
		stack: { ...comparison.groups.stack, trend: groupTrend({ minutes: -10, cost: -80, agents: 10 }) },
		all: { ...comparison.groups.all, trend: groupTrend({ minutes: -60, mutation_score: 5, ci_first_pass: 0 }) },
	},
};

beforeEach(() => {
	getBuildComparison.mockReset();
	getServerBuildComparison.mockReset();
	exportBuildComparison.mockReset();
	(globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
		...(globalThis as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
		getBuildComparison,
		getServerBuildComparison,
		exportBuildComparison,
	};
});

describe("HowYouCompare", () => {
	it("compares a project of this computer with the person's own projects", async () => {
		getBuildComparison.mockResolvedValue({ success: true, data: comparison });
		render(<HowYouCompare projectPath="/work/shop" />);
		expect(await screen.findByTestId("how-you-compare")).toBeInTheDocument();
		expect(getBuildComparison).toHaveBeenCalledWith("/work/shop");
		expect(screen.getByText(/Nothing leaves your computer/)).toBeInTheDocument();
		expect(screen.getByText("csharp")).toBeInTheDocument();
		expect(screen.getByText("Medium repo")).toBeInTheDocument();
		expect(screen.getAllByText("-50%")).toHaveLength(2);
		expect(screen.getByText("+10%")).toBeInTheDocument();
		expect(screen.getByText("1.5 h")).toBeInTheDocument();
		// One group is too small for a median.
		expect(screen.getByText(/A group's median shows from 2 active projects/)).toBeInTheDocument();
		const own = screen.getByText("Side project").closest("tr") as HTMLElement;
		expect(within(own).getByText(/Other stack · Size unknown · Solo/)).toBeInTheDocument();
		expect(screen.queryByText("Shop")).toBeNull();
		// No group has a trend: no pace to read.
		expect(screen.queryByTestId("compare-pace")).toBeNull();
		expect(screen.queryByText(/moved from/)).toBeNull();
	});

	it("adds the team, the top tenth, the weeks and the kinds of work", async () => {
		getBuildComparison.mockResolvedValue({ success: true, data: comparison });
		render(<HowYouCompare projectPath="/work/shop" />);
		expect(await screen.findByText("Team of 2-5")).toBeInTheDocument();
		expect(screen.getByText("Same team size")).toBeInTheDocument();
		expect(screen.getByText("top 10%: 12 min")).toBeInTheDocument();
		expect(screen.getByText("top 10%: $0.40")).toBeInTheDocument();
		expect(screen.getByText(/shows from 10 active projects/)).toBeInTheDocument();
		expect(screen.getByText("Last 4 weeks")).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Build time, week by week" })).toBeInTheDocument();
		const kinds = screen.getByTestId("compare-kinds");
		const bug = within(kinds).getByText("Bug fix").closest("tr") as HTMLElement;
		expect(within(bug).getByText("45 min")).toBeInTheDocument();
		const upgrade = within(kinds).getByText("Version upgrade").closest("tr") as HTMLElement;
		expect(within(upgrade).getByText("1 project")).toBeInTheDocument();
	});

	it("says when the project moves segment, and reads its pace against its peers", async () => {
		getBuildComparison.mockResolvedValue({ success: true, data: moving });
		exportBuildComparison.mockResolvedValue({ success: true, data: "/r.pdf" });
		render(<HowYouCompare projectPath="/work/shop" />);
		expect(await screen.findByText("Small repo → Medium repo")).toBeInTheDocument();
		expect(screen.getByText("Solo → Team of 2-5")).toBeInTheDocument();
		expect(screen.getByText(/moved from Small repo to Medium repo in the last 30 days/)).toBeInTheDocument();
		expect(screen.getByText(/moved from Solo to Team of 2-5/)).toBeInTheDocument();
		expect(screen.getByText("80%")).toBeInTheDocument();
		expect(screen.getByText("trend: -10%")).toBeInTheDocument();
		const pace = within(screen.getByTestId("compare-pace"));
		// Each figure against the narrowest group with a trend for it.
		expect(
			pace.getByText("Build time: -50% for this project, -10% for the median of “Same stack”. You are improving faster."),
		).toBeInTheDocument();
		expect(pace.getByText(/Cost \(USD\): -50% .* “Same stack”\. Your peers are improving faster\./)).toBeInTheDocument();
		expect(pace.getByText(/Mutation score: \+20% .* \+5% .* “All projects”\. You are improving faster\./)).toBeInTheDocument();
		expect(pace.getAllByText(/About the same pace/)).toHaveLength(2);
		expect(pace.queryByText(/QA iterations/)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Generate team report/ }));
		await waitFor(() => expect(exportBuildComparison).toHaveBeenCalledTimes(1));
		const [document] = exportBuildComparison.mock.calls[0];
		expect(document.summary.join(" ")).toMatch(/moved from Small repo to Medium repo/);
		expect(document.summary.join(" ")).toMatch(/Build time: -50% for this project/);
		expect(document.tables[0].rows[0]).toContain("1.5 h · trend: -10%");
		expect(document.tables[0].rows[0]).toContain("35 min · top 10%: 12 min · trend: -60%");
	});

	it("says when no spec has a kind and no group has a top tenth", async () => {
		getBuildComparison.mockResolvedValue({
			success: true,
			data: {
				...comparison,
				segment: { stack: "other", size: "large", team: "unknown", size_from: null, team_from: null },
				kinds: [],
				min_top: null,
				weeks: [week(1, 10)],
			},
		});
		exportBuildComparison.mockResolvedValue({ success: true, data: null });
		render(<HowYouCompare projectPath="/work/shop" />);
		expect(await screen.findByText(/No spec of this period has a kind/)).toBeInTheDocument();
		expect(screen.queryByText(/Top 10% is the figure/)).toBeNull();
		expect(screen.queryByRole("img", { name: /week by week/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Generate team report/ }));
		await waitFor(() => expect(exportBuildComparison).toHaveBeenCalledTimes(1));
		const [document] = exportBuildComparison.mock.calls[0];
		expect(document.summary).toContain("Segment: Other stack, Large repo, Team unknown.");
		expect(document.tables.map((table: { title: string }) => table.title)).toEqual([
			"How you compare",
			"Your other projects",
		]);
	});

	it("generates the team report and says where it went", async () => {
		getBuildComparison.mockResolvedValue({ success: true, data: comparison });
		exportBuildComparison
			.mockResolvedValueOnce({ success: true, data: "/reports/compare.pdf" })
			.mockResolvedValueOnce({ success: true, data: null })
			.mockResolvedValueOnce({ success: false, error: "Disk full" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("gone"))
			.mockRejectedValueOnce("odd");
		render(<HowYouCompare projectPath="/work/shop" />);
		const button = await screen.findByRole("button", { name: /Generate team report/ });
		fireEvent.click(button);
		expect(await screen.findByTestId("compare-report-saved")).toHaveTextContent("/reports/compare.pdf");
		const [document] = exportBuildComparison.mock.calls[0];
		expect(document.title).toBe("How you compare: team report");
		expect(document.summary).toContain("Segment: csharp, Medium repo, Team of 2-5.");
		expect(document.tables.map((table: { title: string }) => table.title)).toEqual([
			"How you compare",
			"By kind of work",
			"Your other projects",
		]);
		expect(document.tables[0].rows[0]).toContain("35 min · top 10%: 12 min");
		expect(document.tables[1].rows[0]).toEqual(["Bug fix", "2", "20 min / 45 min", "$0.50 / $0.75", "1 / —", "2 / 2", "— / —", "— / —"]);
		expect(document.tables[1].rows[1][2]).toBe("1.2 h / —");
		expect(document.tables[2].rows).toEqual([["Side project", "1", "10 min", "$0.20", "—", "1", "—", "—"]]);
		// Cancelled: nothing said.
		fireEvent.click(button);
		await waitFor(() => expect(exportBuildComparison).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.queryByTestId("compare-report-saved")).toBeNull());
		fireEvent.click(button);
		expect(await screen.findByText("Disk full")).toBeInTheDocument();
		fireEvent.click(button);
		expect(await screen.findByText("Could not save the team report")).toBeInTheDocument();
		fireEvent.click(button);
		expect(await screen.findByText("gone")).toBeInTheDocument();
		fireEvent.click(button);
		await waitFor(() => expect(exportBuildComparison).toHaveBeenCalledTimes(6));
		expect(await screen.findByText("Could not save the team report")).toBeInTheDocument();
	});

	it("says so when no other project built a spec", async () => {
		getBuildComparison.mockResolvedValue({
			success: true,
			data: {
				...comparison,
				projects: [comparison.projects[0]],
				groups: { ...comparison.groups, segment: { projects: 2, medians: comparison.groups.all.medians } },
			},
		});
		render(<HowYouCompare projectPath="/work/shop" />);
		expect(await screen.findByText(/None of your other projects/)).toBeInTheDocument();
		expect(screen.queryByText(/A group's median shows from/)).toBeNull();
	});

	it("asks the server for a server project, and lists no project", async () => {
		getServerBuildComparison.mockResolvedValue({
			success: true,
			data: { ...comparison, min_group: 5, projects: [] },
		});
		exportBuildComparison.mockResolvedValue({ success: true, data: "/r.pdf" });
		render(<HowYouCompare projectPath="/mirror" serverProjectId="p1" />);
		expect(await screen.findByText(/groups of 5 projects or more/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Generate team report/ }));
		await waitFor(() => expect(exportBuildComparison).toHaveBeenCalledTimes(1));
		const [document] = exportBuildComparison.mock.calls[0];
		// The server's report names no project, and says how it was compared.
		expect(document.tables.map((table: { title: string }) => table.title)).not.toContain("Your other projects");
		expect(document.summary.join(" ")).toMatch(/groups of 5 projects or more/);
		expect(getServerBuildComparison).toHaveBeenCalledWith("p1");
		expect(getBuildComparison).not.toHaveBeenCalled();
		expect(screen.queryByText("Your other projects")).toBeNull();
	});

	it("shows the refusal, then retries", async () => {
		getBuildComparison
			.mockResolvedValueOnce({ success: false, error: "Unknown project" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("boom"))
			.mockRejectedValueOnce("odd")
			.mockResolvedValueOnce({ success: true, data: comparison });
		render(<HowYouCompare projectPath="/work/shop" />);
		expect(await screen.findByText("Unknown project")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
		expect(await screen.findByText("Could not compare this project")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
		expect(await screen.findByText("boom")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
		await waitFor(() => expect(getBuildComparison).toHaveBeenCalledTimes(4));
		expect(await screen.findByText("Could not compare this project")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
		expect(await screen.findByTestId("how-you-compare")).toBeInTheDocument();
	});
});

describe("the figures", () => {
	it("are written per metric, a dash when nothing recorded them", () => {
		expect(formatMetric("cost", null)).toBe("—");
		expect(formatMetric("cost", 1.234)).toBe("$1.23");
		expect(formatMetric("minutes", 12.4)).toBe("12 min");
		expect(formatMetric("minutes", 90)).toBe("1.5 h");
		expect(formatMetric("agents", 2)).toBe("2");
		expect(formatMetric("qa_iterations", 1.5)).toBe("1.5");
	});

	it("draw a sparkline through the weeks that built a spec", () => {
		expect(sparklinePoints([null, 5])).toBeNull();
		expect(sparklinePoints([2, 2])).toBe("0.0,16.0 72.0,16.0");
		expect(sparklinePoints([0, null, 10])).toBe("0.0,16.0 72.0,2.0");
	});

	it("count a fall as good news, and a rise of a figure where more is better", () => {
		expect(trendTone("cost", null)).toBe("muted");
		expect(trendTone("cost", 3)).toBe("muted");
		expect(trendTone("cost", -20)).toBe("green");
		expect(trendTone("cost", 20)).toBe("amber");
		expect(trendTone("mutation_score", 20)).toBe("green");
		expect(trendTone("ci_first_pass", -20)).toBe("amber");
	});

	it("write the two figures in percent", () => {
		expect(formatMetric("mutation_score", 72.4)).toBe("72%");
		expect(formatMetric("ci_first_pass", 100)).toBe("100%");
	});
});
