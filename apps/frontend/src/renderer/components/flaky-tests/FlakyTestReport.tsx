import { AlertTriangle, Check, FlaskConical, Play, RotateCcw, ScanSearch, X } from "lucide-react";
import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSharedAnalysisReport } from "../../hooks/useSharedAnalysisReport";
import { SharedReportNote } from "../analyses/SharedReportNote";
import {
	Bar,
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	type Tone,
} from "../charter";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
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

const CONFIDENCE_TONE: Record<FlakyConfidence, Tone> = {
	high: "red",
	medium: "amber",
	low: "muted",
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

	const commands = useFlakyTestsStore((s) => s.commands);
	const remote = useFlakyTestsStore((s) => s.remote);
	const runs = useFlakyTestsStore((s) => s.runs);
	const canRun = Boolean(projectPath) && !isScanning && (remote || commands.length > 0);

	return (
		<ModuleStage data-testid="flaky-tests-view">
			<Columns template="minmax(300px, 36%) minmax(0, 1fr)">
				<Column kicker={t("kickers.run")} title={t("run.title")} tone="blue">
					<div className="flex flex-col gap-3">
						{projectPath ? (
							<RunPanel projectPath={projectPath} isScanning={isScanning} t={t} />
						) : (
							<Notice tone="red" icon={AlertTriangle}>
								{t("errors.noProject")}
							</Notice>
						)}
						{isScanning && <ActivityView activity={activity} status={status} t={t} />}
					</div>
				</Column>
				<Column
					kicker={t("kickers.report")}
					title={report ? t("reportTitle") : t("title")}
					meta={report ? `${report.flakyCount} / ${report.totalTests}` : undefined}
					tone="red"
				>
					<div className="flex flex-col gap-3">
						{phase === "error" && error && <ErrorView error={error} t={t} />}
						{report && !isScanning ? (
							<ReportBody report={report} t={t} />
						) : (
							!isScanning &&
							phase !== "error" && (
								<EmptyStage icon={FlaskConical} title={t("emptyReportTitle")} tone="red">
									{t("noData")}
								</EmptyStage>
							)
						)}
					</div>
				</Column>
			</Columns>
			<Composer
				prompt={
					<span className="wp-muted flex min-w-0 items-center gap-2 text-xs">
						<AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						<span className="truncate">{t("description")}</span>
						{!isScanning && <SharedReportNote saved={shared} />}
					</span>
				}
				hint={t("run.help")}
				actions={
					isScanning ? (
						<CharterButton variant="danger" icon={X} onClick={() => cancelScan()}>
							{t("actions.cancel")}
						</CharterButton>
					) : (
						<>
							{report && (
								<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
									{t("actions.reset")}
								</CharterButton>
							)}
							<CharterButton
								icon={ScanSearch}
								disabled={!projectPath}
								onClick={() => projectPath && startScan(projectPath)}
							>
								{t("actions.runScan")}
							</CharterButton>
							<CharterButton
								variant="primary"
								icon={Play}
								disabled={!canRun}
								onClick={() => projectPath && startRuns(projectPath)}
							>
								{t("run.start", { count: runs })}
							</CharterButton>
						</>
					)
				}
			/>
		</ModuleStage>
	);
}

function RunPanel({
	projectPath,
	isScanning,
	t,
}: {
	readonly projectPath: string;
	readonly isScanning: boolean;
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

	return (
		<>
			{!known && <ScanLine label={t("run.detecting")} />}
			{known && remote && <Notice tone="blue">{t("run.remote")}</Notice>}
			{known && !remote && commands.length === 0 && (
				<Notice tone="amber" icon={AlertTriangle}>
					{t("run.noCommand")}
				</Notice>
			)}
			<Panel className="flex flex-col gap-3">
				{known && commands.length > 0 && (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="flaky-command" className="wp-kicker">
							{t("run.command")}
						</Label>
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
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="flaky-runs" className="wp-kicker">
						{t("run.runs")}
					</Label>
					<Input
						id="flaky-runs"
						type="number"
						className="w-28"
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
			</Panel>
		</>
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
			<ScanLine label={activityText(activity, status, t)} />
			{activity.mode === "run" && activity.runs > 0 && (
				<Bar value={(done / activity.runs) * 100} tone="blue" />
			)}
			{done > 0 && (
				<ul className="wp-meta flex flex-col gap-1 whitespace-normal">
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
		return (
			<Notice tone="red" icon={AlertTriangle} role="alert">
				{t("errors.failed", { error })}
			</Notice>
		);
	}
	// The first line repeats the code in English; the rest is the tool's output.
	const output = detail.split("\n").slice(code === "no_results" ? 1 : 0).join("\n");
	return (
		<Notice tone="red" icon={AlertTriangle} role="alert">
			<p>{t(`errors.${code}`)}</p>
			{output.trim() && <pre className="wp-code mt-2 max-h-64 overflow-auto">{output.trim()}</pre>}
		</Notice>
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
			<EmptyStage icon={FlaskConical} title={t("empty.noReports")} tone="amber">
				{command ? t("empty.noReportsHint", { command }) : t("empty.noReportsHintGeneric")}
			</EmptyStage>
		);
	}

	const minRuns = report.minRuns ?? FLAKY_MIN_RUNS;
	const fewRuns = report.runCount !== undefined && report.runCount < minRuns;
	const alwaysFailing = report.alwaysFailing ?? [];

	return (
		<div className="flex flex-col gap-4">
			<p className="wp-muted text-sm">{summaryText(report, t)}</p>

			{fewRuns && (
				<Notice tone="amber" icon={AlertTriangle}>
					{t("empty.fewRuns", { runs: report.runCount, min: minRuns })}
				</Notice>
			)}
			{code === "no_flaky" && !fewRuns && (
				<Notice tone="green" icon={Check}>
					{t("empty.noFlaky")}
				</Notice>
			)}

			<div className="flex flex-col gap-2">
				{report.flakyTests.map((test) => (
					<Panel key={test.testName} rail tone={CONFIDENCE_TONE[test.confidence]}>
						<div className="mb-1 flex items-start justify-between gap-3">
							<p className="wp-mono break-all text-sm font-medium">{test.testName}</p>
							<Chip tone={CONFIDENCE_TONE[test.confidence]}>
								{t(`confidenceLevel.${test.confidence}`)}
							</Chip>
						</div>
						<div className="wp-meta flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-normal">
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
						<p className="mt-2 text-xs text-success">{t(`fixes.${test.probableCause}`)}</p>
						{test.errorPatterns[0] && (
							<details className="mt-2 text-xs">
								<summary className="cursor-pointer text-muted-foreground">
									{t("errorSample")}
								</summary>
								<pre className="wp-code mt-1">{test.errorPatterns[0]}</pre>
							</details>
						)}
					</Panel>
				))}
			</div>

			{alwaysFailing.length > 0 && (
				<details className="wp-card wp-card-pad">
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
