/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployWatch } from "../../../../shared/types/deploy-watch";
import { useCICDTriggersStore } from "../../../stores/cicd-triggers-store";
import { useProjectStore } from "../../../stores/project-store";
import { CICDTriggersDashboard } from "../CICDTriggersDashboard";
import { DeployMonitorSettings } from "../DeployMonitorSettings";
import { canRollBack, DeployWatchPanel, isWatchRunning } from "../DeployWatchPanel";

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
		lastMetrics: [
			{ name: "errors", kind: "error_rate", baseline: 0.01, current: 0.05, changePct: 400, level: "critical" },
			{ name: "p95", kind: "latency", baseline: null, current: null, changePct: null, level: "unknown" },
		],
		healthOk: false,
		samples: 2,
		problems: [],
		rollback: "proposed",
		rollbackByPerson: false,
		...over,
	};
}

describe("canRollBack", () => {
	it("only after the window, on a bad verdict, when the provider can", () => {
		expect(canRollBack(watch())).toBe(true);
		expect(canRollBack(watch({ phase: "watching" }))).toBe(false);
		expect(canRollBack(watch({ verdict: "ok" }))).toBe(false);
		expect(canRollBack(watch({ verdict: "warning", phase: "interrupted" }))).toBe(true);
		expect(canRollBack(watch({ rollback: "started" }))).toBe(false);
		expect(canRollBack(watch({ rollback: "manual" }))).toBe(false);
		const manualPlan = {
			provider: "gitlab",
			reason: "manual",
			automatic: false,
			targetRun: "8",
			targetSha: "",
			targetUrl: "",
			currentSha: "",
		};
		expect(canRollBack(watch({ rollback: undefined, plan: manualPlan }))).toBe(false);
		expect(isWatchRunning(undefined)).toBe(false);
		expect(isWatchRunning(watch({ phase: "baseline" }))).toBe(true);
	});
});

describe("DeployWatchPanel", () => {
	it("says when nothing is watched", () => {
		render(<DeployWatchPanel watch={watch({ notConfigured: true })} busy={false} onRollback={vi.fn()} />);
		expect(screen.getByText("cicdTriggers:watch.notConfigured")).toBeTruthy();
	});

	it("shows the verdict and asks before rolling back", () => {
		const onRollback = vi.fn();
		render(<DeployWatchPanel watch={watch()} busy={false} onRollback={onRollback} />);
		expect(screen.getByText("cicdTriggers:watch.verdict.critical")).toBeTruthy();
		expect(screen.getByText("cicdTriggers:watch.healthFailed")).toBeTruthy();
		expect(screen.getByText(/"change":"400"/)).toBeTruthy();
		expect(screen.getByText(/"name":"p95","baseline":"—"/)).toBeTruthy();
		fireEvent.click(screen.getByText("cicdTriggers:watch.rollbackButton"));
		fireEvent.click(screen.getByText("cicdTriggers:watch.cancel"));
		expect(onRollback).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("cicdTriggers:watch.rollbackButton"));
		fireEvent.click(screen.getByText("cicdTriggers:watch.confirmButton"));
		expect(onRollback).toHaveBeenCalledTimes(1);
	});

	it("shows migrations, problems, the link and the revert hint", () => {
		render(
			<DeployWatchPanel
				watch={watch({
					verdict: "ok",
					healthOk: true,
					lastMetrics: [],
					problems: ["offline: Prometheus skipped"],
					migrations: ["db/migrate/1_add.rb"],
					rollback: "started",
					rollbackByPerson: true,
					plan: {
						provider: "github",
						reason: "rerun",
						automatic: true,
						targetRun: "10",
						targetSha: "",
						targetUrl: "https://github.com/acme/shop/actions/runs/10",
						currentSha: "",
					},
				})}
				busy={false}
				onRollback={vi.fn()}
			/>,
		);
		expect(screen.getByText("cicdTriggers:watch.healthOk")).toBeTruthy();
		expect(screen.getByText(/watch\.problems/)).toBeTruthy();
		expect(screen.getByText(/watch\.migrations/)).toBeTruthy();
		expect(screen.getByText("cicdTriggers:watch.byPerson")).toBeTruthy();
		expect(screen.getByText("cicdTriggers:watch.revertHint")).toBeTruthy();
		expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/acme/shop/actions/runs/10");
		expect(screen.queryByText("cicdTriggers:watch.rollbackButton")).toBeNull();
	});

	it("explains a manual plan and a failed rollback", () => {
		render(
			<DeployWatchPanel
				watch={watch({
					healthOk: null,
					rollback: "failed",
					plan: {
						provider: "jenkins",
						reason: "manual",
						automatic: false,
						targetRun: "41",
						targetSha: "",
						targetUrl: "",
						currentSha: "",
					},
				})}
				busy
				onRollback={vi.fn()}
			/>,
		);
		expect(screen.getByText("cicdTriggers:watch.rollback.failed").className).toContain("text-destructive");
		expect(screen.getByText(/watch\.plan\.manual/)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});
});

describe("DeployMonitorSettings", () => {
	it("saves a changed field on blur, not an unchanged one", () => {
		const onSave = vi.fn();
		render(
			<DeployMonitorSettings
				config={{ monitor_health_url: "https://a/h", auto_rollback: false } as never}
				onSave={onSave}
			/>,
		);
		const health = screen.getByLabelText("cicdTriggers:monitor.monitor_health_url");
		fireEvent.blur(health);
		// Typed then put back: the draft equals the saved value, so nothing is saved.
		fireEvent.change(health, { target: { value: "https://a/x" } });
		fireEvent.change(health, { target: { value: "https://a/h" } });
		fireEvent.blur(health);
		expect(onSave).not.toHaveBeenCalled();
		const prom = screen.getByLabelText("cicdTriggers:monitor.monitor_prometheus_url");
		fireEvent.change(prom, { target: { value: " http://localhost:9090 " } });
		fireEvent.blur(prom);
		expect(onSave).toHaveBeenCalledWith({ monitor_prometheus_url: "http://localhost:9090" });
		fireEvent.click(screen.getByRole("switch"));
		expect(onSave).toHaveBeenCalledWith({ auto_rollback: true });
	});

	it("works before the config is read", () => {
		const onSave = vi.fn();
		render(<DeployMonitorSettings config={null} onSave={onSave} />);
		const field = screen.getByLabelText("cicdTriggers:monitor.monitor_window_minutes");
		fireEvent.change(field, { target: { value: "20" } });
		fireEvent.blur(field);
		expect(onSave).toHaveBeenCalledWith({ monitor_window_minutes: "20" });
	});
});

describe("CICDTriggersDashboard with a watch", () => {
	const invoke = vi.fn();
	const rollbackDeployment = vi.fn(async () => ({ success: true }));

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		invoke.mockReset();
		invoke.mockImplementation(async (channel: string) => {
			if (channel === "cicdTriggers:getConfig") return { success: true, data: { provider: "github" } };
			if (channel === "cicdTriggers:listRuns") {
				return {
					success: true,
					data: [
						{
							id: "42",
							triggered_at: "2026-11-15T10:00:00Z",
							status: "triggered",
							provider: "github",
							pr_url: "",
							branch: "main",
							watch: watch({ phase: "watching" }),
						},
						{
							id: "41",
							triggered_at: "2026-11-15T09:00:00Z",
							status: "triggered",
							provider: "github",
							pr_url: "",
							branch: "main",
							watch: watch(),
						},
					],
				};
			}
			return { success: true };
		});
		(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, rollbackDeployment };
		useProjectStore.setState({
			projects: [{ id: "p1", name: "shop", path: "/projects/shop" } as never],
			activeProjectId: "p1",
			selectedProjectId: "p1",
		} as never);
		useCICDTriggersStore.setState({ config: null, runs: [], error: null, rollingBack: null });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads the runs again while a deployment is watched, and rolls back on request", async () => {
		render(<CICDTriggersDashboard />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(screen.getByTestId("deploy-monitor-settings")).toBeTruthy();
		expect(screen.getAllByTestId("deploy-watch")).toHaveLength(2);
		const reads = invoke.mock.calls.filter(([c]) => c === "cicdTriggers:listRuns").length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(invoke.mock.calls.filter(([c]) => c === "cicdTriggers:listRuns").length).toBeGreaterThan(reads);

		fireEvent.click(screen.getByText("cicdTriggers:watch.rollbackButton"));
		await act(async () => {
			fireEvent.click(screen.getByText("cicdTriggers:watch.confirmButton"));
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(rollbackDeployment).toHaveBeenCalledWith("/projects/shop", "41");

		fireEvent.blur(screen.getByLabelText("cicdTriggers:monitor.monitor_health_url"));
		const field = screen.getByLabelText("cicdTriggers:monitor.monitor_health_url");
		fireEvent.change(field, { target: { value: "https://app/h" } });
		await act(async () => {
			fireEvent.blur(field);
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(invoke).toHaveBeenCalledWith("cicdTriggers:setConfig", "/projects/shop", {
			monitor_health_url: "https://app/h",
		});
	});
});
