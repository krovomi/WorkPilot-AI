import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSharedAnalysisReport } from "../../hooks/useSharedAnalysisReport";
import { SharedReportNote } from "../analyses/SharedReportNote";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Progress } from "../ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	type FlakyActivity,
	useFlakyTestsStore,
} from "../../stores/flaky-tests-store";
import {
	FLAKY_MAX_RUNS,
	FLAKY_MIN_RUNS,
	type FlakyCommandId,
	type FlakyConfidence,
	type FlakyReport,
} from "../../../shared/types/flaky-tests";

type T = (key: string, opts?: Record<string, unknown>) => string;

const CONFIDENCE_STYLES: Record<FlakyConfidence, string> = {
	high: "text-red-400 bg-red-500/10",
	medium: "text-yellow-400 bg-yellow-500/10",
	low: "text-muted-foreground bg-card",
};

const ERROR_CODES = ["no_command", "no_results", "start_failed"] as const;

/**
 * The runner's error, ``<code>: <message>`` (wrapped by the IPC layer as
 * "Error invoking remote method …: Error: <code>: …"): the code the view
 * words, and what follows it (a build output, the missing tool).
 */
export function parseRunnerError(error: string): {
	code: (typeof ERROR_CODES)[number] | null;
	detail: string;
} {
	for (const code of ERROR_CODES) {
		const at = error.indexOf(`${code}: `);
		if (at >= 0) {
			return { code, detail: error.slice(at + code.length + 2).trim() };
		}
	}
	return { code: null, detail: error };
}

interface FlakyTestReportProps {
	readonly projectPath?: string;
}

export function FlakyTestReport({
	projectPath,
}: FlakyTestReportProps): React.ReactElement {
	const { t } = useTranslation("flakyTests");

	const phase = useFlakyTestsStore((s) => s.phase);
	const status = useFlakyTestsStore((s) => s.status);
	const activity = useFlakyTestsStore((s) => s.activity);
	const report = useFlakyTestsStore((s) => s.report);
	const error = useFlakyTestsStore((s) => s.error);
	const startScan = useFlakyTestsStore((s) => s.startScan);
	const startRuns = useFlakyTestsStore((s) => s.startRuns);
	const cancelScan = useFlakyTestsStore((s) => s.cancelScan);
	const reset = useFlakyTestsStore((s) => s.reset);
	const setReport = useFlakyTestsStore((s) => s.setReport);
	const detectedFor = useFlakyTestsStore((s) => s.detectedFor);
	const detectCommands = useFlakyTestsStore((s) => s.detectCommands);

	const isScanning = phase === "scanning";
	// A server project's last report, saved on the server by any member.
	const shared = useSharedAnalysisReport(
		"flaky-tests",
		projectPath,
		setReport,
		isScanning,
	);

	useEffect(() => {
		if (projectPath && detectedFor !== projectPath) {
			void detectCommands(projectPath);
		}
	}, [projectPath, detectedFor, detectCommands]);

	return (
		<div className="flex flex-col gap-5 p-6 max-w-5xl bg-background text-foreground">
			<header>
				<h1 className="text-xl font-semibold">{t("title")}</h1>
				<p className="text-sm text-muted-foreground mt-1">
					{t("description")}
				</p>
			</header>

			{projectPath ? (
				<RunPanel
					projectPath={projectPath}
					isScanning={isScanning}
					hasReport={!!report}
					onRun={() => startRuns(projectPath)}
					onScan={() => startScan(projectPath)}
					onCancel={() => cancelScan()}
					onReset={reset}
					t={t}
				/>
			) : (
				<p className="text-sm text-muted-foreground">{t("errors.noProject")}</p>
			)}

			{!isScanning && <SharedReportNote saved={shared} />}

			{isScanning && <ActivityView activity={activity} status={status} t={t} />}

			{phase === "error" && error && <ErrorView error={error} t={t} />}

			{report && !isScanning ? (
				<ReportBody report={report} t={t} />
			) : (
				phase === "idle" &&
				projectPath && (
					<p className="text-sm text-muted-foreground">{t("noData")}</p>
				)
			)}
		</div>
	);
}

function RunPanel({
	projectPath,
	isScanning,
	hasReport,
	onRun,
	onScan,
	onCancel,
	onReset,
	t,
}: {
	readonly projectPath: string;
	readonly isScanning: boolean;
	readonly hasReport: boolean;
	readonly onRun: () => void;
	readonly onScan: () => void;
	readonly onCancel: () => void;
	readonly onReset: () => void;
	readonly t: T;
}): React.ReactElement {
	const detecting = useFlakyTestsStore((s) => s.detecting);
	const detectedFor = useFlakyTestsStore((s) => s.detectedFor);
	const commands = useFlakyTestsStore((s) => s.commands);
	const remote = useFlakyTestsStore((s) => s.remote);
	const commandId = useFlakyTestsStore((s) => s.commandId);
	const runs = useFlakyTestsStore((s) => s.runs);
	const setCommandId = useFlakyTestsStore((s) => s.setCommandId);
	const setRuns = useFlakyTestsStore((s) => s.setRuns);

	const known = detectedFor === projectPath && !detecting;
	const canRun = !isScanning && (remote || commands.length > 0);

	return (
		<section className="rounded-lg border border-border p-4 flex flex-col gap-4">
			<h2 className="text-sm font-semibold">{t("run.title")}</h2>

			{!known && (
				<p className="text-sm text-muted-foreground">{t("run.detecting")}</p>
			)}
			{known && remote && (
				<p className="text-sm text-muted-foreground">{t("run.remote")}</p>
			)}
			{known && !remote && commands.length === 0 && (
				<p className="text-sm text-yellow-400">{t("run.noCommand")}</p>
			)}

			<div className="flex flex-wrap items-end gap-4">
				{known && commands.length > 0 && (
					<div className="flex flex-col gap-1.5 min-w-64">
						<Label htmlFor="flaky-command">{t("run.command")}</Label>
						<Select
							value={commandId === "auto" ? commands[0].id : commandId}
							onValueChange={(value) => setCommandId(value as FlakyCommandId)}
							disabled={isScanning}
						>
							<SelectTrigger id="flaky-command">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{commands.map((command) => (
									<SelectItem key={command.id} value={command.id}>
										<span className="font-mono text-xs">{command.command}</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
				<div className="flex flex-col gap-1.5 w-36">
					<Label htmlFor="flaky-runs">{t("run.runs")}</Label>
					<Input
						id="flaky-runs"
						type="number"
						min={FLAKY_MIN_RUNS}
						max={FLAKY_MAX_RUNS}
						value={runs}
						disabled={isScanning}
						onChange={(event) => {
							const value = Number.parseInt(event.target.value, 10);
							if (Number.isNaN(value)) return;
							setRuns(Math.min(FLAKY_MAX_RUNS, Math.max(FLAKY_MIN_RUNS, value)));
						}}
					/>
				</div>
			</div>

			<p className="text-xs text-muted-foreground">{t("run.help")}</p>

			<div className="flex flex-wrap items-center gap-3">
				{isScanning ? (
					<Button variant="destructive" size="sm" onClick={onCancel}>
						{t("actions.cancel")}
					</Button>
				) : (
					<>
						<Button size="sm" onClick={onRun} disabled={!canRun}>
							{t("run.start", { count: runs })}
						</Button>
						<Button variant="outline" size="sm" onClick={onScan}>
							{t("actions.runScan")}
						</Button>
						{hasReport && (
							<Button variant="ghost" size="sm" onClick={onReset}>
								{t("actions.reset")}
							</Button>
						)}
					</>
				)}
			</div>
		</section>
	);
}

/** What the detective is doing now, worded from the event codes. */
export function activityText(activity: FlakyActivity, status: string, t: T): string {
	switch (activity.code) {
		case "discovering":
			return t("progress.discovering");
		case "parsing":
			return t("progress.parsing", { count: activity.reports });
		case "running":
			return t("progress.starting", { command: activity.command });
		case "run_started":
		case "run_finished":
			return t("progress.run", {
				run: activity.run,
				runs: activity.runs,
				command: activity.command,
			});
		case "analysing":
			return t("progress.analysing");
		default:
			return status || t("actions.scanning");
	}
}

function ActivityView({
	activity,
	status,
	t,
}: {
	readonly activity: FlakyActivity;
	readonly status: string;
	readonly t: T;
}): React.ReactElement {
	const done = activity.finished.length;
	return (
		<section className="flex flex-col gap-3" aria-live="polite">
			<p className="text-sm text-muted-foreground animate-pulse">
				{activityText(activity, status, t)}
			</p>
			{activity.mode === "run" && activity.runs > 0 && (
				<Progress value={(done / activity.runs) * 100} animated />
			)}
			{done > 0 && (
				<ul className="text-xs text-muted-foreground space-y-1 font-mono">
					{activity.finished.map((r) => (
						<li key={r.run}>
							{r.passed + r.failed === 0
								? t("progress.noReport", { run: r.run })
								: t("progress.runResult", {
										run: r.run,
										passed: r.passed,
										failed: r.failed,
										duration: r.durationS,
									})}
							{r.timedOut && ` — ${t("progress.timedOut")}`}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function ErrorView({
	error,
	t,
}: {
	readonly error: string;
	readonly t: T;
}): React.ReactElement {
	const { code, detail } = parseRunnerError(error);
	if (!code) {
		return <p className="text-sm text-red-400">{t("errors.failed", { error })}</p>;
	}
	// The first line repeats the code in English; the rest is the tool's output.
	const output = detail.split("\n").slice(code === "no_results" ? 1 : 0).join("\n");
	return (
		<section className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 flex flex-col gap-2">
			<p className="text-sm text-red-400">{t(`errors.${code}`)}</p>
			{output.trim() && (
				<pre className="text-xs font-mono whitespace-pre-wrap max-h-64 overflow-auto text-muted-foreground">
					{output.trim()}
				</pre>
			)}
		</section>
	);
}

function summaryText(report: FlakyReport, t: T): string {
	const counts = { flaky: report.flakyCount, total: report.totalTests };
	if (report.mode === "run" && report.command) {
		return t("summaryRun", {
			...counts,
			runs: report.runCount ?? 0,
			command: report.command,
		});
	}
	if (report.mode === "scan") {
		return t("summaryScan", { ...counts, reports: report.reportCount ?? 0 });
	}
	return t("summary", counts);
}

function ReportBody({
	report,
	t,
}: {
	readonly report: FlakyReport;
	readonly t: T;
}): React.ReactElement {
	// An older report (or one saved by an older server) has no summary code.
	const code =
		report.summaryCode ??
		(report.totalTests === 0 ? "no_reports" : report.flakyCount ? "flaky" : "no_flaky");

	if (code === "no_reports") {
		const command = report.detectedCommands?.[0]?.command;
		return (
			<section className="rounded-lg border border-dashed border-border p-6 text-center flex flex-col gap-2">
				<p className="text-sm font-medium">{t("empty.noReports")}</p>
				<p className="text-sm text-muted-foreground">
					{command
						? t("empty.noReportsHint", { command })
						: t("empty.noReportsHintGeneric")}
				</p>
			</section>
		);
	}

	const minRuns = report.minRuns ?? FLAKY_MIN_RUNS;
	const fewRuns = report.runCount !== undefined && report.runCount < minRuns;
	const alwaysFailing = report.alwaysFailing ?? [];

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground">{summaryText(report, t)}</p>

			{fewRuns && (
				<p className="text-sm text-yellow-400">
					{t("empty.fewRuns", { runs: report.runCount, min: minRuns })}
				</p>
			)}
			{code === "no_flaky" && !fewRuns && (
				<p className="text-sm text-green-400">{t("empty.noFlaky")}</p>
			)}

			<div className="space-y-2">
				{report.flakyTests.map((test) => (
					<div
						key={test.testName}
						className="px-4 py-3 rounded-lg border border-border hover:bg-card transition-colors"
					>
						<div className="flex items-start justify-between gap-3 mb-1">
							<p className="text-sm font-medium font-mono break-all">{test.testName}</p>
							<span
								className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${CONFIDENCE_STYLES[test.confidence]}`}
							>
								{t(`confidenceLevel.${test.confidence}`)}
							</span>
						</div>
						<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
							<span>
								{t("failedRuns", {
									failures: test.failures,
									total: test.totalRuns,
									rate: (test.flakinessRate * 100).toFixed(0),
								})}
							</span>
							<span>
								{t("cause")} {t(`causes.${test.probableCause}`)}
							</span>
						</div>
						<p className="text-xs mt-2 text-green-400">
							{t(`fixes.${test.probableCause}`)}
						</p>
						{test.errorPatterns[0] && (
							<details className="mt-2 text-xs">
								<summary className="cursor-pointer text-muted-foreground">
									{t("errorSample")}
								</summary>
								<pre className="mt-1 font-mono whitespace-pre-wrap text-muted-foreground">
									{test.errorPatterns[0]}
								</pre>
							</details>
						)}
					</div>
				))}
			</div>

			{alwaysFailing.length > 0 && (
				<details className="rounded-lg border border-border px-4 py-3">
					<summary className="cursor-pointer text-sm font-medium">
						{t("alwaysFailing.title", { count: alwaysFailing.length })}
					</summary>
					<p className="text-xs text-muted-foreground mt-2">
						{t("alwaysFailing.description")}
					</p>
					<ul className="mt-2 space-y-1 text-xs font-mono break-all">
						{alwaysFailing.map((name) => (
							<li key={name}>{name}</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}
