/**
 * "How you compare": the project's figures against its past and its peers;
 * the person's own projects listed on this computer only, and a group's
 * median hidden below the group size.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildComparison } from "@shared/types/build-compare";
import { formatMetric, HowYouCompare, trendTone } from "../HowYouCompare";

const getBuildComparison = vi.fn();
const getServerBuildComparison = vi.fn();

const comparison: BuildComparison = {
	window_days: 30,
	min_group: 2,
	segment: { stack: "csharp", size: "medium" },
	recent: { specs: 2, minutes: 40, cost: 1.5, qa_iterations: 1, agents: 3 },
	previous: { specs: 1, minutes: 80, cost: 3, qa_iterations: null, agents: 3 },
	trend: { minutes: -50, cost: -50, qa_iterations: null, agents: 10 },
	groups: {
		segment: { projects: 1, medians: null },
		stack: { projects: 2, medians: { minutes: 90, cost: 1, qa_iterations: null, agents: 2 } },
		all: { projects: 3, medians: { minutes: 35, cost: 1.2, qa_iterations: 2, agents: 2 } },
	},
	projects: [
		{ name: "Shop", stack: "csharp", size: "medium", specs: 2, minutes: 40, cost: 1.5, qa_iterations: 1, agents: 3, current: true },
		{ name: "Side project", stack: "other", size: "unknown", specs: 1, minutes: 10, cost: 0.2, qa_iterations: null, agents: 1, current: false },
	],
};

beforeEach(() => {
	getBuildComparison.mockReset();
	getServerBuildComparison.mockReset();
	(globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
		...(globalThis as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
		getBuildComparison,
		getServerBuildComparison,
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
		expect(within(own).getByText(/Other stack · Size unknown/)).toBeInTheDocument();
		expect(screen.queryByText("Shop")).toBeNull();
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
		render(<HowYouCompare projectPath="/mirror" serverProjectId="p1" />);
		expect(await screen.findByText(/groups of 5 projects or more/)).toBeInTheDocument();
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

	it("count a fall as good news", () => {
		expect(trendTone(null)).toBe("muted");
		expect(trendTone(3)).toBe("muted");
		expect(trendTone(-20)).toBe("green");
		expect(trendTone(20)).toBe("amber");
	});
});
