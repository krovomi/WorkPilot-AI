/**
 * @vitest-environment jsdom
 *
 * What lot 4 of #366 shows on a run's watch and in the settings: linked
 * services, a person's word on the verdict, the way to investigate, canary
 * metrics, the link settings and the figures.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeployWatch, DeployWatchFigures as Figures } from "../../../../shared/types/deploy-watch";
import { DeployLinkSettings } from "../DeployLinkSettings";
import { DeployWatchFigures, formatDuration, TARGET_SECONDS } from "../DeployWatchFigures";
import { canReview } from "../DeployWatchExtras";
import { DeployWatchPanel } from "../DeployWatchPanel";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values && typeof values === "object" && Object.keys(values).length
				? `${key}${JSON.stringify(values)}`
				: key,
	}),
}));

function watch(over: Partial<DeployWatch> = {}): DeployWatch {
	return {
		runId: "42",
		phase: "done",
		verdict: "critical",
		startedAt: "2026-11-15T10:00:00Z",
		notConfigured: false,
		autoRollback: false,
		lastMetrics: [],
		healthOk: null,
		samples: 2,
		problems: [],
		rollbackByPerson: false,
		linkedCause: "",
		linkedOnly: false,
		...over,
	};
}

const INCIDENT = {
	criticalSamples: 2,
	warningSamples: 0,
	healthChecks: 0,
	healthFailed: 0,
	metrics: [],
	explanation: "",
};

describe("the watch of a run, lot 4", () => {
	afterEach(() => vi.restoreAllMocks());

	it("shows a canary metric against the stable fleet", () => {
		render(
			<DeployWatchPanel
				watch={watch({
					lastMetrics: [
						{ name: "errors", kind: "error_rate", baseline: 1, current: 2, changePct: 100, level: "critical", canary: true },
					],
				})}
				busy={false}
				onRollback={vi.fn()}
			/>,
		);
		expect(screen.getByText(/watch\.metricCanary/)).toBeTruthy();
	});

	it("lists the linked services the rollback took back", () => {
		render(
			<DeployWatchPanel
				watch={watch({
					rollback: "started",
					linked: [
						{
							projectId: "p2",
							name: "web",
							status: "manual",
							runId: "1",
							targetUrl: "https://gitlab.com/acme/web/-/pipelines/7",
							migrations: ["db/1.sql"],
						},
						{ projectId: "p3", name: "", status: "error", runId: "", targetUrl: "", migrations: [] },
					],
				})}
				busy={false}
				onRollback={vi.fn()}
				linkedNames={["web"]}
			/>,
		);
		const list = screen.getByTestId("deploy-linked");
		expect(list.textContent).toContain('watch.linked.manual{"project":"web"}');
		expect(list.textContent).toContain("watch.linked.migrations");
		expect(list.textContent).toContain('watch.linked.error{"project":"p3"}');
		expect(screen.getByRole("link").getAttribute("href")).toBe("https://gitlab.com/acme/web/-/pipelines/7");
		expect(screen.getByText(/watch\.linked\.error/).className).toContain("text-destructive");
		expect(screen.queryByText(/watch\.linkedByHand/)).toBeNull();
	});

	it("says the linked services need a person when this rollback does", () => {
		const { rerender } = render(
			<DeployWatchPanel watch={watch({ rollback: "manual" })} busy={false} onRollback={vi.fn()} linkedNames={["web"]} />,
		);
		expect(screen.getByText(/watch\.linkedByHand.*web/)).toBeTruthy();
		rerender(<DeployWatchPanel watch={watch({ rollback: "manual" })} busy={false} onRollback={vi.fn()} />);
		expect(screen.queryByText(/watch\.linkedByHand/)).toBeNull();
		rerender(
			<DeployWatchPanel watch={watch({ rollback: "proposed" })} busy={false} onRollback={vi.fn()} linkedNames={["web"]} />,
		);
		expect(screen.queryByText(/watch\.linkedByHand/)).toBeNull();
	});

	it("names the project a run went back with", () => {
		render(
			<DeployWatchPanel
				watch={watch({ rollback: "started", linkedCause: "Shop API", linkedOnly: true, verdict: "unknown" })}
				busy={false}
				onRollback={vi.fn()}
			/>,
		);
		expect(screen.getByText(/watch\.withProject.*Shop API/)).toBeTruthy();
	});

	it("takes a word on the verdict, and takes it back", () => {
		const onReview = vi.fn();
		const { rerender } = render(
			<DeployWatchPanel watch={watch()} busy={false} onRollback={vi.fn()} onReview={onReview} />,
		);
		fireEvent.click(screen.getByText("cicdTriggers:watch.review.confirmed"));
		expect(onReview).toHaveBeenLastCalledWith("confirmed");
		rerender(
			<DeployWatchPanel watch={watch({ review: "confirmed" })} busy={false} onRollback={vi.fn()} onReview={onReview} />,
		);
		const confirmed = screen.getByText("cicdTriggers:watch.review.confirmed").closest("button");
		expect(confirmed?.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(screen.getByText("cicdTriggers:watch.review.confirmed"));
		expect(onReview).toHaveBeenLastCalledWith(null);
		expect(canReview(watch({ verdict: "ok" }))).toBe(false);
		expect(canReview(watch({ phase: "watching" }))).toBe(false);
		expect(canReview(watch({ verdict: "warning" }))).toBe(true);
	});

	it("opens Self-Healing and the task from the incident report", () => {
		const events: Array<{ view: string; taskId?: string }> = [];
		const listener = (e: Event) => events.push((e as CustomEvent).detail);
		window.addEventListener("workpilot:navigate-view", listener);
		const { rerender } = render(
			<DeployWatchPanel watch={watch({ incident: INCIDENT })} busy={false} onRollback={vi.fn()} taskId="t-1" />,
		);
		fireEvent.click(screen.getByText("cicdTriggers:watch.investigate.selfHealing"));
		fireEvent.click(screen.getByText("cicdTriggers:watch.investigate.task"));
		expect(events).toEqual([{ view: "self-healing" }, { view: "kanban", taskId: "t-1" }]);
		rerender(<DeployWatchPanel watch={watch({ incident: INCIDENT })} busy={false} onRollback={vi.fn()} />);
		expect(screen.queryByText("cicdTriggers:watch.investigate.task")).toBeNull();
		window.removeEventListener("workpilot:navigate-view", listener);
	});
});

describe("DeployLinkSettings", () => {
	it("switches projects on and off", () => {
		const onSave = vi.fn();
		render(
			<DeployLinkSettings
				links={{ linked: [{ id: "p2", name: "web" }], candidates: [{ id: "p3", name: "api" }] }}
				onSave={onSave}
			/>,
		);
		fireEvent.click(screen.getByLabelText("api"));
		expect(onSave).toHaveBeenLastCalledWith(["p2", "p3"]);
		fireEvent.click(screen.getByLabelText("web"));
		expect(onSave).toHaveBeenLastCalledWith([]);
	});

	it("says when there is no other project", () => {
		render(<DeployLinkSettings links={null} onSave={vi.fn()} />);
		expect(screen.getByText("cicdTriggers:links.none")).toBeTruthy();
	});
});

describe("DeployWatchFigures", () => {
	const figures: Figures = {
		watches: 4,
		criticalVerdicts: 2,
		warningVerdicts: 1,
		automaticRollbacks: 1,
		personRollbacks: 1,
		incidentsAvoided: 1,
		meanSecondsToRollback: 300,
		medianSecondsToRollback: 300,
		timedRollbacks: 2,
		falsePositiveRollbacks: 1,
		reviewedVerdicts: 3,
		falsePositives: 1,
		months: [{ month: "2026-11", automatic: 1, person: 1, critical: 2 }],
	};

	it("shows the figures, the false alarm rate and a slow median", () => {
		render(<DeployWatchFigures figures={figures} />);
		const panel = screen.getByTestId("deploy-figures");
		expect(panel.textContent).toContain('"rate":33');
		expect(panel.textContent).toContain('"mean":"5 min 00 s"');
		expect(screen.getByText("cicdTriggers:figures.slow")).toBeTruthy();
		expect(screen.getByTestId("deploy-figures-months").textContent).toContain("2026-11");
	});

	it("says when no verdict was reviewed, and keeps quiet under the goal", () => {
		render(
			<DeployWatchFigures
				figures={{ ...figures, reviewedVerdicts: 0, medianSecondsToRollback: 45, meanSecondsToRollback: null }}
			/>,
		);
		expect(screen.getByTestId("deploy-figures").textContent).toContain("cicdTriggers:figures.noReview");
		expect(screen.queryByText("cicdTriggers:figures.slow")).toBeNull();
	});

	it("writes durations", () => {
		expect(formatDuration(null)).toBe("—");
		expect(formatDuration(45)).toBe("45 s");
		expect(formatDuration(125)).toBe("2 min 05 s");
		expect(TARGET_SECONDS).toBe(180);
	});
});
