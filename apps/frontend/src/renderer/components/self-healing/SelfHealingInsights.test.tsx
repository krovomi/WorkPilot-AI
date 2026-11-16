/**
 * @vitest-environment jsdom
 */
/**
 * The trends of the proactive view (#370) and the groups of the production
 * view (#372): what each shows, and that each stays silent with nothing to say.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type {
	FileRiskTrend,
	Incident,
	IncidentCluster,
	RiskTrendReport,
} from "../../../shared/types/self-healing";
import { IncidentCard } from "./IncidentCard";
import { IncidentClusters } from "./IncidentClusters";
import { IncidentGroupInfo } from "./IncidentGroupInfo";
import { ProactiveHotlist } from "./ProactiveHotlist";
import { sparklinePoints } from "./RiskTrajectoryChart";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key} ${JSON.stringify(options)}` : key,
		i18n: { language: "en" },
	}),
}));

function trend(file: string, extra: Partial<FileRiskTrend> = {}): FileRiskTrend {
	return {
		file,
		trajectory: "fast_rise",
		slope: 6.25,
		acceleration: 0,
		risk: 68,
		start_risk: 35,
		reset: false,
		entered_hot: false,
		complexity_change_pct: 40,
		churn_start: 1,
		churn_now: 9,
		points: [
			{ day: "2026-06-01", risk: 35 },
			{ day: "2026-06-22", risk: 68 },
		],
		...extra,
	};
}

function report(extra: Partial<RiskTrendReport> = {}): RiskTrendReport {
	return {
		snapshots: 6,
		window_days: 90,
		files: 3,
		counts: { new: 0, stable: 1, slow_rise: 1, fast_rise: 1, improving: 0 },
		hot: [],
		rising: [],
		improving: [],
		entered_hot: [],
		clusters: [],
		...extra,
	};
}

describe("ProactiveHotlist", () => {
	it("says it needs history before there is any", () => {
		const { rerender } = render(<ProactiveHotlist report={null} />);
		expect(screen.getByTestId("trends-empty")).toHaveTextContent('{"count":0}');

		rerender(<ProactiveHotlist report={report({ files: 2, counts: { ...report().counts, new: 2 } })} />);
		expect(screen.getByTestId("trends-empty")).toHaveTextContent('{"count":6}');
	});

	it("lists hot files, rising files and degrading directories", () => {
		render(
			<ProactiveHotlist
				report={report({
					hot: [
						trend("src/pay/a.ts", { entered_hot: true }),
						trend("src/pay/b.ts", { reset: true, complexity_change_pct: -12 }),
					],
					rising: [trend("lib/c.rb", { trajectory: "slow_rise" })],
					clusters: [
						{
							directory: "src/pay",
							files: ["src/pay/a.ts", "src/pay/b.ts"],
							rising: 2,
							fast: 2,
							total: 3,
							share: 0.67,
							mean_slope: 6,
						},
					],
				})}
			/>,
		);
		const rows = screen.getAllByTestId("trend-row");
		expect(rows).toHaveLength(3);
		expect(within(rows[0]).getByText("selfHealing:trends.newlyHot")).toBeInTheDocument();
		expect(rows[0]).toHaveTextContent('"pct":"+40"');
		expect(within(rows[1]).getByText("selfHealing:trends.reset")).toBeInTheDocument();
		expect(rows[1]).toHaveTextContent('"pct":"-12"');
		expect(screen.getByTestId("risk-clusters")).toHaveTextContent("src/pay");
		expect(screen.queryByText("selfHealing:trends.noHot")).not.toBeInTheDocument();
	});

	it("says when nothing is hot", () => {
		render(<ProactiveHotlist report={report()} />);
		expect(screen.getByText("selfHealing:trends.noHot")).toBeInTheDocument();
		expect(screen.queryByText("selfHealing:trends.rising")).not.toBeInTheDocument();
		expect(screen.queryByTestId("risk-clusters")).not.toBeInTheDocument();
	});
});

describe("sparklinePoints", () => {
	it("maps the risk to the box, oldest on the left", () => {
		expect(sparklinePoints([], 100, 20)).toBe("");
		expect(sparklinePoints([{ day: "2026-06-01", risk: 50 }], 100, 20)).toBe("50.0,10.0");
		expect(
			sparklinePoints(
				[
					{ day: "2026-06-01", risk: -5 },
					{ day: "2026-06-11", risk: 150 },
				],
				100,
				20,
			),
		).toBe("0.0,20.0 100.0,0.0");
		// Two scans the same day: no division by a zero span.
		expect(
			sparklinePoints(
				[
					{ day: "2026-06-01", risk: 0 },
					{ day: "2026-06-01", risk: 100 },
				],
				10,
				10,
			),
		).toBe("0.0,10.0 0.0,0.0");
	});
});

function incident(source_data: Record<string, unknown>): Incident {
	return {
		id: "inc1",
		mode: "production",
		source: "sentry",
		severity: "low",
		title: "AttributeError",
		description: "",
		status: "pending",
		created_at: "2026-10-10T00:00:00",
		source_data,
		affected_files: [],
	};
}

describe("IncidentGroupInfo", () => {
	it("renders nothing for an incident that was never grouped", () => {
		const { container } = render(
			<IncidentGroupInfo incident={incident({ group: { sources: "sentry" }, fingerprint: 7 })} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the reports, sources, inherited priority and suspects", () => {
		render(
			<IncidentGroupInfo
				incident={incident({
					group: { sources: ["datadog", "sentry"], report_count: 3 },
					fingerprint: "0123abcd",
					inherited_from: { commit: "c".repeat(40), severity: "critical" },
					suspect_commits: [
						{ sha: "d".repeat(40), subject: "refactor orders", files: [], score: 1, committed_at: 0 },
					],
				})}
			/>,
		);
		const box = screen.getByTestId("incident-group");
		expect(box).toHaveTextContent('"count":3');
		expect(screen.getByText("datadog")).toBeInTheDocument();
		expect(box).toHaveTextContent("0123abcd");
		expect(box).toHaveTextContent('"commit":"cccccccc"');
		expect(screen.getByText("dddddddd")).toBeInTheDocument();
		expect(screen.getByText("refactor orders")).toBeInTheDocument();
	});

	it("shows a fingerprint alone, without a group or suspects", () => {
		render(
			<IncidentGroupInfo
				incident={incident({ fingerprint: "ffee", inherited_from: { severity: "high" }, suspect_commits: "x" })}
			/>,
		);
		const box = screen.getByTestId("incident-group");
		expect(box).toHaveTextContent("ffee");
		expect(screen.queryByText("selfHealing:groups.seenBy")).not.toBeInTheDocument();
		expect(screen.queryByText("selfHealing:groups.suspects")).not.toBeInTheDocument();
		expect(box).not.toHaveTextContent("selfHealing:groups.inherited");

		cleanup();
		render(<IncidentGroupInfo incident={incident({ fingerprint: "aabb" })} />);
		expect(screen.getByTestId("incident-group")).not.toHaveTextContent("selfHealing:groups.inherited");
	});
});

describe("IncidentClusters", () => {
	const cluster: IncidentCluster = {
		id: "cl1",
		commit: "e".repeat(40),
		subject: "move the cache",
		incident_ids: ["a", "b"],
		severity: "high",
		occurrences: 120,
		affected_users: 8,
		sources: ["sentry"],
	};

	it("renders nothing without a cluster", () => {
		const { container } = render(<IncidentClusters clusters={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("names the commit and what one fix covers", () => {
		render(<IncidentClusters clusters={[cluster]} />);
		const box = screen.getByTestId("incident-clusters");
		expect(box).toHaveTextContent("eeeeeeee");
		expect(box).toHaveTextContent("move the cache");
		expect(box).toHaveTextContent('"count":2');
		expect(box).toHaveTextContent("selfHealing:groups.oneFix");
	});
});

describe("IncidentCard", () => {
	it("renders what a mode adds under the incident", () => {
		render(
			<IncidentCard incident={incident({})}>
				<p data-testid="slot">extra</p>
			</IncidentCard>,
		);
		expect(screen.getByTestId("slot")).toBeInTheDocument();
	});
});
