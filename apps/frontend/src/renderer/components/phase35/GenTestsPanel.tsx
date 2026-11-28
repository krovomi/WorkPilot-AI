/**
 * #3.10 Generational Testing panel.
 *
 * A generation is one run of the project's tests, kept under a label. Later
 * runs are compared to it: tests that regressed, vanished, got slower, failed
 * for the first time or were added.
 *
 * Two sources, for every stack: run the project's own suite (the command is
 * detected from its manifests: dotnet test, pytest, Vitest, Jest, Maven,
 * Gradle, go test, cargo test, PHPUnit, RSpec, Dart/Flutter, Swift), or import
 * or paste a report (JUnit XML, TRX, Jest/Vitest JSON, go test -json, cargo
 * test output, Dart JSON, RSpec JSON; the format is read from the content).
 */

import type { TFunction } from "i18next";
import {
	AlertTriangle,
	Camera,
	FileUp,
	FlaskConical,
	GitCompare,
	History,
	Info,
	Play,
	Square,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { RegressionReport } from "../../../preload/api/modules/phase35-features-api";
import { formatAppDateTime } from "../../lib/date-format";
import { type GenSource, useGenTestsStore } from "../../stores/phase35-stores";
import { CharterButton, Chip, Chips, EmptyStage, Notice, ScanLine, Stat, Stats, Tabs, type Tone } from "../charter";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { PanelShell } from "./_panel-shell";
import { translateBackendError } from "./_translate-backend-error";

interface GenTestsPanelProps {
	projectPath: string;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LABEL_MAX_LEN = 128;
const REPORT_MAX_LEN = 5_000_000;
const AUTO = "auto";

const REPORT_ERRORS = ["empty", "too_large", "invalid_xml", "unknown_format", "no_tests", "unreadable"];
const RUN_ERRORS = [
	"no_command",
	"no_dotnet_tests",
	"start_failed",
	"timed_out",
	"no_tests",
	"no_results",
	"no_baseline",
	"busy",
	"invalid",
	"runner_failed",
	"not_a_directory",
];

const KIND_TONE: Record<string, Tone> = {
	regressed: "red",
	new_failure: "orange",
	vanished: "amber",
	slowed_down: "violet",
	added: "green",
};
const KINDS = ["regressed", "new_failure", "vanished", "slowed_down", "added"] as const;

/** A label nobody has to invent: the date and time of the capture. */
export const defaultLabel = (now: Date = new Date()): string => {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `gen-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
};

/** What an error code of the runner or the archive means, and its detail (the run's output). */
export function describeGenError(raw: string, t: TFunction): { message: string; detail: string } {
	if (raw.startsWith("report.")) {
		const code = raw.slice("report.".length);
		if (REPORT_ERRORS.includes(code)) return { message: t(`genTests.errors.report.${code}`), detail: "" };
	}
	const match = /^([a-z_]+):\s?([\s\S]*)$/.exec(raw);
	if (match && RUN_ERRORS.includes(match[1])) {
		return { message: t(`genTests.errors.run.${match[1]}`), detail: match[2].trim() };
	}
	if (raw === "busy") return { message: t("genTests.errors.run.busy"), detail: "" };
	// Never null here: the panel only describes an error it has.
	return { message: translateBackendError(raw, t) as string, detail: "" };
}

const durationText = (seconds: number | null): string =>
	seconds === null ? "—" : seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`;

export function GenTestsPanel({ projectPath }: GenTestsPanelProps) {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		generations,
		regression,
		commands,
		lastSource,
		running,
		listGenerations,
		detect,
		capture,
		compare,
		runSuite,
		cancel,
		importFile,
		deleteGen,
		reset,
	} = useGenTestsStore(
		useShallow((s) => ({
			phase: s.phase,
			error: s.error,
			generations: s.generations,
			regression: s.regression,
			commands: s.commands,
			lastSource: s.lastSource,
			running: s.running,
			listGenerations: s.listGenerations,
			detect: s.detect,
			capture: s.capture,
			compare: s.compare,
			runSuite: s.runSuite,
			cancel: s.cancel,
			importFile: s.importFile,
			deleteGen: s.deleteGen,
			reset: s.reset,
		})),
	);
	const [source, setSource] = useState<GenSource>("run");
	const [commandId, setCommandId] = useState(AUTO);
	const [report, setReport] = useState("");
	const [reportName, setReportName] = useState<string | null>(null);
	const [label, setLabel] = useState(() => defaultLabel());
	const [baseline, setBaseline] = useState("");

	useEffect(() => {
		reset();
		setBaseline("");
		if (!projectPath) return;
		void listGenerations(projectPath);
		void detect(projectPath);
	}, [projectPath, listGenerations, detect, reset]);

	// The newest generation is the usual baseline.
	useEffect(() => {
		if (!generations.some((g) => g.label === baseline)) setBaseline(generations[0]?.label ?? "");
	}, [generations, baseline]);

	const busy = phase === "running";
	const labelTaken = generations.some((g) => g.label === label);
	const labelValid = LABEL_RE.test(label);
	const hasCommand = (commands?.length ?? 0) > 0;
	const sourceReady = source === "run" ? hasCommand : report.trim().length > 0;
	const canCapture = Boolean(projectPath) && !busy && labelValid && sourceReady;
	const canCompare = Boolean(projectPath) && !busy && Boolean(baseline) && sourceReady;
	const shownError = useMemo(() => (error ? describeGenError(error, t) : null), [error, t]);

	const onCapture = async () => {
		const done =
			source === "run"
				? await runSuite(projectPath, "capture", label, commandId)
				: await capture(projectPath, label, report);
		if (done) setLabel(defaultLabel());
	};
	const onCompare = () =>
		source === "run" ? runSuite(projectPath, "compare", baseline, commandId) : compare(projectPath, baseline, report);
	const onImport = async () => {
		const file = await importFile();
		if (!file) return;
		setReport(file.content.slice(0, REPORT_MAX_LEN));
		setReportName(file.name);
	};

	return (
		<PanelShell title={t("genTests.title")} subtitle={t("genTests.subtitle")}>
			{!projectPath ? (
				<Notice tone="amber" icon={Info}>
					{t("common.projectPathRequired")}
				</Notice>
			) : (
				<div className="space-y-5 text-sm">
					{shownError && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							<p>{shownError.message}</p>
							{shownError.detail && (
								<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{shownError.detail}</pre>
							)}
						</Notice>
					)}

					<section className="space-y-3" aria-labelledby="gen-source">
						<h3 id="gen-source" className="font-medium">
							{t("genTests.source.heading")}
						</h3>
						<Tabs
							label={t("genTests.source.heading")}
							value={source}
							onChange={setSource}
							tabs={[
								{ id: "run", label: t("genTests.source.run"), icon: Play },
								{ id: "report", label: t("genTests.source.report"), icon: FileUp },
							]}
						/>
						{source === "run" ? (
							<RunSource
								commands={commands}
								commandId={commandId}
								onCommand={setCommandId}
								onUseReport={() => setSource("report")}
							/>
						) : (
							<div className="space-y-2">
								<div className="flex flex-wrap items-center gap-2">
									<CharterButton size="sm" icon={FileUp} onClick={onImport} disabled={busy}>
										{t("genTests.report.import")}
									</CharterButton>
									{reportName && <code className="text-xs">{reportName}</code>}
								</div>
								<Textarea
									spellCheck={false}
									value={report}
									onChange={(e) => {
										setReport(e.target.value.slice(0, REPORT_MAX_LEN));
										setReportName(null);
									}}
									rows={5}
									aria-label={t("genTests.report.paste")}
									placeholder={t("genTests.report.paste")}
									className="w-full p-2 font-mono text-xs min-h-0"
								/>
								<p className="text-xs text-muted-foreground">{t("genTests.report.formats")}</p>
							</div>
						)}
					</section>

					<div className="grid gap-4 md:grid-cols-2">
						<section className="space-y-2" aria-labelledby="gen-capture">
							<h3 id="gen-capture" className="font-medium">
								{t("genTests.capture")}
							</h3>
							<Input
								value={label}
								onChange={(e) => setLabel(e.target.value.slice(0, LABEL_MAX_LEN))}
								maxLength={LABEL_MAX_LEN}
								aria-label={t("genTests.label")}
								aria-invalid={!labelValid || undefined}
								placeholder={t("genTests.label")}
								className="w-full p-2 text-sm h-auto"
							/>
							{!labelValid && <p className="text-xs text-destructive">{t("genTests.validation.labelInvalid")}</p>}
							{labelValid && labelTaken && (
								<p className="text-xs text-muted-foreground">{t("genTests.validation.labelTaken")}</p>
							)}
							<CharterButton
								variant="primary"
								icon={Camera}
								busy={running === "capture"}
								onClick={onCapture}
								disabled={!canCapture}
							>
								{t(source === "run" ? "genTests.captureRun" : "genTests.captureReport")}
							</CharterButton>
						</section>

						<section className="space-y-2" aria-labelledby="gen-compare">
							<h3 id="gen-compare" className="font-medium">
								{t("genTests.compare")}
							</h3>
							{generations.length === 0 ? (
								<p className="text-xs text-muted-foreground">{t("genTests.noBaseline")}</p>
							) : (
								<Select value={baseline} onValueChange={setBaseline}>
									<SelectTrigger aria-label={t("genTests.baseline")}>
										<SelectValue placeholder={t("genTests.baseline")} />
									</SelectTrigger>
									<SelectContent>
										{generations.map((g) => (
											<SelectItem key={g.label} value={g.label}>
												{g.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
							<CharterButton icon={GitCompare} busy={running === "compare"} onClick={onCompare} disabled={!canCompare}>
								{t(source === "run" ? "genTests.compareRun" : "genTests.compareReport")}
							</CharterButton>
						</section>
					</div>

					{busy && (
						<div className="flex items-center gap-3">
							<div className="flex-1">
								<ScanLine label={t(source === "run" ? "genTests.runningSuite" : "genTests.readingReport")} />
							</div>
							{source === "run" && (
								<CharterButton size="sm" variant="ghost" icon={Square} onClick={cancel}>
									{t("genTests.cancel")}
								</CharterButton>
							)}
						</div>
					)}

					{lastSource && !busy && phase === "ok" && (
						<p className="text-xs text-muted-foreground">
							{lastSource.kind === "run"
								? t("genTests.lastRun", { command: lastSource.value })
								: t("genTests.lastReport", { format: t(`genTests.formats.${lastSource.value}`, { defaultValue: lastSource.value }),
									})}
						</p>
					)}

					{regression && <RegressionView regression={regression} />}

					<section className="space-y-2" aria-labelledby="gen-list">
						<h3 id="gen-list" className="font-medium">
							{t("genTests.generations")} ({generations.length})
						</h3>
						{generations.length === 0 ? (
							<EmptyStage icon={History} title={t("genTests.emptyTitle")}>
								{t("genTests.emptyHint")}
							</EmptyStage>
						) : (
							<ul className="space-y-1.5">
								{generations.map((g) => (
									<li key={g.label} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
										<code className="font-medium">{g.label}</code>
										<span className="text-xs text-muted-foreground">
											{formatAppDateTime(g.captured_at * 1000)}
										</span>
										<Chips>
											<Chip tone="green">{t("genTests.counts.passed", { count: g.passed })}</Chip>
											{g.failed + g.error > 0 && (
												<Chip tone="red">{t("genTests.counts.failed", { count: g.failed + g.error })}</Chip>
											)}
											{g.skipped > 0 && <Chip tone="muted">{t("genTests.counts.skipped", { count: g.skipped })}</Chip>}
										</Chips>
										<span className="text-xs text-muted-foreground">{sourceText(g.source, t)}</span>
										<CharterButton
											size="sm"
											variant="ghost"
											icon={Trash2}
											className="ml-auto"
											aria-label={t("genTests.delete", { label: g.label })}
											title={t("genTests.delete", { label: g.label })}
											disabled={busy}
											onClick={() => deleteGen(projectPath, g.label)}
										/>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			)}
		</PanelShell>
	);
}

/** Where a generation came from: a run of a command, or a report of a format. */
function sourceText(source: string, t: TFunction): string {
	if (source.startsWith("run:")) return t("genTests.fromRun", { command: source.slice(4) });
	const format = source.split(":")[0];
	const known = ["junit", "trx", "jest", "go", "cargo", "dart", "rspec"].includes(format);
	return t("genTests.fromReport", { format: known ? t(`genTests.formats.${format}`) : format || "—" });
}

function RunSource({
	commands,
	commandId,
	onCommand,
	onUseReport,
}: {
	readonly commands: ReadonlyArray<{ id: string; label: string; command: string }> | null;
	readonly commandId: string;
	readonly onCommand: (id: string) => void;
	readonly onUseReport: () => void;
}) {
	const { t } = useTranslation("phase35");
	if (commands === null) return <ScanLine label={t("genTests.detecting")} />;
	if (commands.length === 0) {
		return (
			<Notice tone="amber" icon={FlaskConical}>
				<p>{t("genTests.noCommand")}</p>
				<CharterButton size="sm" className="mt-2" icon={FileUp} onClick={onUseReport}>
					{t("genTests.useReport")}
				</CharterButton>
			</Notice>
		);
	}
	const chosen = commands.find((c) => c.id === commandId) ?? commands[0];
	return (
		<div className="space-y-2">
			{commands.length > 1 && (
				<Select value={commandId === AUTO ? commands[0].id : commandId} onValueChange={onCommand}>
					<SelectTrigger aria-label={t("genTests.command")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{commands.map((c) => (
							<SelectItem key={c.id} value={c.id}>
								{c.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<p className="text-xs text-muted-foreground">
				{t("genTests.willRun")} <code>{chosen.command}</code>
			</p>
		</div>
	);
}

function RegressionView({ regression }: { readonly regression: RegressionReport }) {
	const { t } = useTranslation("phase35");
	const items = regression.items;
	return (
		<section className="space-y-2" aria-labelledby="gen-result">
			<h3 id="gen-result" className="font-medium">
				{t("genTests.resultTitle", { baseline: regression.baseline_label })}
			</h3>
			<Stats>
				<Stat label={t("genTests.regressions")} value={regression.summary.regressed ?? 0} tone="red" />
				<Stat label={t("genTests.newFailures")} value={regression.summary.new_failure ?? 0} tone="orange" />
				<Stat label={t("genTests.vanished")} value={regression.summary.vanished ?? 0} tone="amber" />
				<Stat label={t("genTests.slowdowns")} value={regression.summary.slowed_down ?? 0} tone="violet" />
				<Stat label={t("genTests.added")} value={regression.summary.added ?? 0} tone="green" />
			</Stats>
			{items.length === 0 ? (
				<Notice tone="green" icon={Info}>
					{t("genTests.noChange")}
				</Notice>
			) : (
				<ul className="max-h-80 space-y-1 overflow-auto text-xs">
					{[...items]
						.sort((a, b) => KINDS.indexOf(a.kind as never) - KINDS.indexOf(b.kind as never))
						.map((it) => (
							<li key={`${it.kind}:${it.test_id}`} className="rounded border px-2 py-1">
								<div className="flex flex-wrap items-center gap-2">
									<Chip tone={KIND_TONE[it.kind] ?? "muted"}>
										{t(`genTests.kinds.${it.kind}`, { defaultValue: it.kind })}
									</Chip>
									<code className="break-all">{it.test_id}</code>
									<span className="ml-auto whitespace-nowrap text-muted-foreground">
										{durationText(it.baseline_duration)} → {durationText(it.current_duration)}
									</span>
								</div>
								{it.detail && (it.kind === "regressed" || it.kind === "new_failure") && (
									<pre className="mt-1 whitespace-pre-wrap text-muted-foreground">{it.detail}</pre>
								)}
							</li>
						))}
				</ul>
			)}
		</section>
	);
}
