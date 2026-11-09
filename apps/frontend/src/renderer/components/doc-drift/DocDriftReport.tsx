/**
 * "Détecteur de dérive de documentation" tab of Docs et dérive, in the UI
 * charter (docs/architecture/ui-charter.md): the scan as three steps on the
 * left, the gaps found in the middle (filtered by severity), the selected
 * gap on the right, the composer at the bottom. The scan reads every
 * language of apps/backend/doc_languages; a server project's last report
 * comes from the server.
 */
import {
	AlertTriangle,
	Check,
	CheckCircle2,
	Copy,
	FileSearch,
	FileWarning,
	MousePointerClick,
	RotateCcw,
	ScanSearch,
	X,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DRIFT_FAMILY,
	type DriftFamily,
	type DriftIssue,
	type DriftReport,
	type DriftSeverity,
} from "../../../shared/types/doc-drift";
import { useSharedAnalysisReport } from "../../hooks/useSharedAnalysisReport";
import { useDocDriftStore } from "../../stores/doc-drift-store";
import { useProjectStore } from "../../stores/project-store";
import { DocDriftExportButtons, DocDriftFixBar, FreshnessCard, issueFix, issueMessage } from "./DocDriftPanels";
import { SharedReportNote } from "../analyses/SharedReportNote";
import {
	CharterButton,
	Chip,
	Chips,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	StepCard,
	type Tone,
} from "../charter";

const SEVERITY_TONE: Record<DriftSeverity, Tone> = {
	high: "red",
	medium: "amber",
	low: "blue",
};
const SEVERITIES: DriftSeverity[] = ["high", "medium", "low"];
const FAMILIES: DriftFamily[] = ["signatures", "examples", "references", "stale"];
const familyOf = (i: DriftIssue): DriftFamily => DRIFT_FAMILY[i.driftType] ?? "references";

const issueKey = (i: DriftIssue) => `${i.docFile}:${i.docLine}:${i.referencedSymbol}:${i.driftType}`;

interface DocDriftReportProps {
	readonly projectPath?: string;
}

type StepState = "pending" | "running" | "done";

function stepStatus(state: StepState, t: (k: string) => string): React.ReactNode {
	if (state === "done") return <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--wp-tone)" }} />;
	return <span className="wp-meta">{t(state === "running" ? "scan.running" : "scan.pending")}</span>;
}

function ScanColumn({ report, scanning, status }: {
	readonly report: DriftReport | null;
	readonly scanning: boolean;
	readonly status: string;
}) {
	const { t } = useTranslation("docDrift");
	const done: StepState = report ? "done" : scanning ? "running" : "pending";
	return (
		<Column kicker={t("scan.kicker")} title={t("scan.title")} meta={report ? `${report.docsScanned} docs` : undefined}>
			<div className="flex flex-col gap-3">
				<StepCard
					index={1}
					kicker={t("scan.stepDocsKicker")}
					title={t("scan.stepDocs")}
					tone="blue"
					status={stepStatus(done, t)}
					meta={report ? t("scan.stepDocsMeta", { count: report.docsScanned }) : undefined}
				/>
				<StepCard
					index={2}
					kicker={t("scan.stepCodeKicker")}
					title={t("scan.stepCode")}
					tone="violet"
					status={stepStatus(done, t)}
					meta={
						report
							? t("scan.stepCodeMeta", {
									files: report.codeFilesIndexed,
									symbols: report.symbolsIndexed ?? "—",
								})
							: undefined
					}
				>
					{report?.languages && report.languages.length > 0 && (
						<div className="mt-1.5">
							<Chips>
								{report.languages.slice(0, 6).map((lang) => (
									<Chip key={lang.label} tone="violet">
										{lang.label} · {lang.files}
									</Chip>
								))}
							</Chips>
						</div>
					)}
				</StepCard>
				<StepCard
					index={3}
					kicker={t("scan.stepCompareKicker")}
					title={t("scan.stepCompare")}
					tone="accent"
					active={scanning}
					status={stepStatus(done, t)}
					meta={report ? t("scan.stepCompareMeta", { count: report.issues.length }) : undefined}
				/>
				{report && <FreshnessCard report={report} />}
				{scanning && <ScanLine label={status || t("actions.scanning")} />}
			</div>
		</Column>
	);
}

function IssuesColumn({ report, selected, onSelect, projectPath, local }: {
	readonly report: DriftReport | null;
	readonly selected: string | null;
	readonly onSelect: (key: string) => void;
	readonly projectPath?: string;
	readonly local: boolean;
}) {
	const { t } = useTranslation("docDrift");
	const [filter, setFilter] = useState<DriftSeverity | "all">("all");
	const [family, setFamily] = useState<DriftFamily | "all">("all");
	const selectedFixes = useDocDriftStore((s) => s.selectedFixes);
	const issues = report?.issues ?? [];
	const inFamily = family === "all" ? issues : issues.filter((i) => familyOf(i) === family);
	const shown = filter === "all" ? inFamily : inFamily.filter((i) => i.severity === filter);
	const counts = useMemo(() => {
		const c: Record<DriftSeverity, number> = { high: 0, medium: 0, low: 0 };
		for (const i of inFamily) c[i.severity] += 1;
		return c;
	}, [inFamily]);
	const familyCounts = useMemo(() => {
		const c: Record<DriftFamily, number> = { references: 0, signatures: 0, examples: 0, stale: 0 };
		for (const i of issues) c[familyOf(i)] += 1;
		return c;
	}, [issues]);

	return (
		<Column
			kicker={t("issues.kicker")}
			title={report ? (issues.length ? t("issues.title", { count: issues.length }) : t("issues.titleNone")) : "—"}
			tone="red"
		>
			{!report && (
				<EmptyStage icon={FileSearch} title={t("issues.emptyTitle")} tone="red">
					{t("issues.emptyHint")}
				</EmptyStage>
			)}
			{report && issues.length === 0 && (
				<Notice tone="green" icon={Check}>
					{t("issues.clean")}
				</Notice>
			)}
			{report && <DocDriftFixBar report={report} projectPath={projectPath} local={local} />}
			{issues.length > 0 && (
				<div className="flex flex-col gap-3">
					<Chips>
						<Chip tone="muted" pressed={family === "all"} onClick={() => setFamily("all")}>
							{t("all")} · {issues.length}
						</Chip>
						{FAMILIES.filter((f) => familyCounts[f] > 0).map((f) => (
							<Chip key={f} tone="violet" pressed={family === f} onClick={() => setFamily(f)}>
								{t(`families.${f}`)} · {familyCounts[f]}
							</Chip>
						))}
					</Chips>
					<Chips>
						<Chip tone="muted" pressed={filter === "all"} onClick={() => setFilter("all")}>
							{t("all")} · {inFamily.length}
						</Chip>
						{SEVERITIES.filter((s) => counts[s] > 0).map((s) => (
							<Chip key={s} tone={SEVERITY_TONE[s]} pressed={filter === s} onClick={() => setFilter(s)}>
								{t(s)} · {counts[s]}
							</Chip>
						))}
					</Chips>
					{shown.length === 0 && <p className="wp-meta">{t("issues.filtered")}</p>}
					{shown.map((issue) => {
						const key = issueKey(issue);
						return (
							<StepCard
								key={key}
								tone={SEVERITY_TONE[issue.severity]}
								kicker={t(`types.${issue.driftType}.label`, issue.driftType.replaceAll("_", " "))}
								title={<span className="wp-mono text-[0.8rem]">{issue.referencedSymbol}</span>}
								meta={`${issue.docFile}:${issue.docLine}`}
								status={
									<span className="wp-meta">
										{issue.fixId && selectedFixes.includes(issue.fixId) ? "✓ " : ""}
										{t(issue.severity)}
									</span>
								}
								active={selected === key}
								onClick={() => onSelect(key)}
							/>
						);
					})}
				</div>
			)}
		</Column>
	);
}

function DetailColumn({ issue, local }: { readonly issue: DriftIssue | null; readonly local: boolean }) {
	const { t } = useTranslation("docDrift");
	const [copied, setCopied] = useState(false);
	const selectedFixes = useDocDriftStore((s) => s.selectedFixes);
	const toggleFix = useDocDriftStore((s) => s.toggleFix);
	return (
		<Column kicker={t("detail.kicker")} title={t("detail.title")} tone="violet">
			{!issue && (
				<EmptyStage icon={MousePointerClick} title={t("detail.emptyTitle")} tone="violet">
					{t("detail.emptyHint")}
				</EmptyStage>
			)}
			{issue && (
				<div className="flex flex-col gap-3">
					<Panel rail tone={SEVERITY_TONE[issue.severity]}>
						<span className="wp-kicker">
							{t(`types.${issue.driftType}.label`, issue.driftType)} · {t(issue.severity)}
						</span>
						<p className="mt-1.5 text-sm leading-relaxed">{issueMessage(t, issue)}</p>
					</Panel>
					<Panel>
						<div className="flex items-center justify-between gap-2">
							<span className="wp-kicker wp-faint">{t("detail.where")}</span>
							<CharterButton
								size="sm"
								variant="ghost"
								icon={copied ? Check : Copy}
								onClick={async () => {
									await navigator.clipboard.writeText(`${issue.docFile}:${issue.docLine}`);
									setCopied(true);
									setTimeout(() => setCopied(false), 1800);
								}}
							>
								{copied ? t("actions.copied") : t("detail.copyRef")}
							</CharterButton>
						</div>
						<p className="wp-mono mt-1 text-xs">
							{issue.docFile}:{issue.docLine}
						</p>
						<span className="wp-kicker wp-faint mt-3 block">{t("detail.cited")}</span>
						<pre className="wp-code mt-1">{(issue.files?.length ? issue.files : [issue.referencedSymbol]).join("\n")}</pre>
					</Panel>
					<Panel rail tone="green">
						<span className="wp-kicker">{t("detail.fix")}</span>
						<p className="mt-1.5 text-sm">{issueFix(t, issue)}</p>
						{issue.fixId && local && (
							<label className="mt-2 flex items-center gap-1.5 text-xs">
								<input
									type="checkbox"
									checked={selectedFixes.includes(issue.fixId)}
									onChange={() => issue.fixId && toggleFix(issue.fixId)}
								/>
								{t("fix.fixable")}
							</label>
						)}
					</Panel>
				</div>
			)}
		</Column>
	);
}

export function DocDriftReport({ projectPath }: DocDriftReportProps): React.ReactElement {
	const { t } = useTranslation("docDrift");

	const phase = useDocDriftStore((s) => s.phase);
	const status = useDocDriftStore((s) => s.status);
	const report = useDocDriftStore((s) => s.report);
	const error = useDocDriftStore((s) => s.error);
	const startScan = useDocDriftStore((s) => s.startScan);
	const cancelScan = useDocDriftStore((s) => s.cancelScan);
	const reset = useDocDriftStore((s) => s.reset);
	const setReport = useDocDriftStore((s) => s.setReport);
	const [selected, setSelected] = useState<string | null>(null);
	// A server project has no folder here: no review branch to write its fixes on.
	const local = useProjectStore((s) => !s.projects.find((p) => p.path === projectPath)?.remote);

	const isScanning = phase === "scanning";
	// A server project's last report, saved on the server by any member.
	const shared = useSharedAnalysisReport("doc-drift", projectPath, setReport, isScanning);
	const selectedIssue = report?.issues.find((i) => issueKey(i) === selected) ?? null;
	const cleanError = error?.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

	return (
		<ModuleStage data-testid="doc-drift-view">
			<Columns template="minmax(260px, 26%) minmax(320px, 38%) minmax(0, 1fr)">
				<ScanColumn report={report} scanning={isScanning} status={status} />
				<IssuesColumn
					report={report}
					selected={selected}
					onSelect={setSelected}
					projectPath={projectPath}
					local={local}
				/>
				<DetailColumn issue={selectedIssue} local={local} />
			</Columns>
			{(!projectPath || (phase === "error" && cleanError)) && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="relative z-[2] mx-5 mb-2">
					{projectPath ? t("errors.failed", { error: cleanError }) : t("errors.noProject")}
				</Notice>
			)}
			<Composer
				prompt={
					<span className="wp-muted flex min-w-0 items-center gap-2 text-xs">
						<FileWarning className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						<span className="truncate">{t("description")}</span>
						{!isScanning && <SharedReportNote saved={shared} />}
					</span>
				}
				hint={t("scan.ignored")}
				actions={
					isScanning ? (
						<CharterButton icon={X} variant="danger" onClick={() => cancelScan()}>
							{t("actions.cancel")}
						</CharterButton>
					) : (
						<>
							{report && <DocDriftExportButtons report={report} />}
							{report && (
								<CharterButton
									icon={RotateCcw}
									onClick={() => {
										setSelected(null);
										reset();
									}}
								>
									{t("actions.reset")}
								</CharterButton>
							)}
							<CharterButton
								variant="primary"
								icon={ScanSearch}
								disabled={!projectPath}
								onClick={() => {
									setSelected(null);
									if (projectPath) void startScan(projectPath);
								}}
							>
								{report ? t("actions.rescan") : t("actions.runScan")}
							</CharterButton>
						</>
					)
				}
			/>
		</ModuleStage>
	);
}
