import { AlertTriangle, Globe, Play, RotateCcw, Search, Square } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSharedAnalysisReport } from "../../hooks/useSharedAnalysisReport";
import { SharedReportNote } from "../analyses/SharedReportNote";
import { setupI18nAgentListeners, useI18nAgentStore } from "../../stores/i18n-agent-store";
import type { I18nIssue, I18nReport } from "../../../shared/types/i18n-agent";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	EmptyStage,
	Gauge,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	ScanLine,
	Section,
	Stat,
	Stats,
	type Tone,
} from "../charter";
import { Input } from "../ui/input";
import { I18nCompletenessSection } from "./I18nCompletenessSection";
import { I18nIssueCard } from "./I18nIssueCard";

/** Cards drawn at once: a large project can report thousands of strings. */
const PAGE_SIZE = 200;

const issueId = (issue: I18nIssue): string =>
	`${issue.issueType}|${issue.file}|${issue.line}|${issue.key}|${issue.locale}|${issue.text ?? ""}`;

const coverageTone = (pct: number): Tone => (pct >= 90 ? "green" : pct >= 70 ? "amber" : "red");

interface I18nReportViewProps {
	readonly projectPath?: string;
}

/** Hard-coded UI text and catalog gaps, across every stack's catalog format. */
export function I18nReportView({ projectPath }: I18nReportViewProps): React.ReactElement {
	const { t } = useTranslation(["i18nAgent", "navigation"]);

	useEffect(() => setupI18nAgentListeners(), []);

	const phase = useI18nAgentStore((s) => s.phase);
	const status = useI18nAgentStore((s) => s.status);
	const report = useI18nAgentStore((s) => s.report);
	const error = useI18nAgentStore((s) => s.error);
	const startScan = useI18nAgentStore((s) => s.startScan);
	const cancelScan = useI18nAgentStore((s) => s.cancelScan);
	const reset = useI18nAgentStore((s) => s.reset);
	const setReport = useI18nAgentStore((s) => s.setReport);
	const local = useProjectStore((s) => !s.projects.find((p) => p.path === projectPath)?.remote);

	const isScanning = phase === "scanning";
	// A server project's last report, saved on the server by any member.
	const shared = useSharedAnalysisReport("i18n", projectPath, setReport, isScanning);

	return (
		<ModuleStage scroll="page" data-testid="i18n-agent-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("i18nAgent:title")}
				description={t("i18nAgent:description")}
				icon={Globe}
				tone="blue"
				actions={
					<>
						{report && !isScanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("i18nAgent:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelScan()}>
								{t("i18nAgent:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("i18nAgent:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				{!isScanning && <SharedReportNote saved={shared} />}
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("i18nAgent:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("i18nAgent:actions.scanning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("i18nAgent:errors.failed", { error })}
					</Notice>
				)}
				{report ? (
					<ReportBody report={report} projectPath={projectPath} local={local} />
				) : (
					phase === "idle" && (
						<EmptyStage icon={Globe} title={t("i18nAgent:emptyTitle")} tone="blue">
							{t("i18nAgent:noData")}
						</EmptyStage>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

interface ReportBodyProps {
	readonly report: I18nReport;
	readonly projectPath?: string;
	readonly local: boolean;
}

function ReportBody({ report, projectPath, local }: ReportBodyProps): React.ReactElement {
	const { t } = useTranslation("i18nAgent");
	const [query, setQuery] = useState("");
	const [type, setType] = useState<string>("all");
	const [shown, setShown] = useState(PAGE_SIZE);
	const q = query.toLowerCase();
	const rtl = report.rtlLocales ?? [];

	const byType = new Map<string, number>();
	for (const issue of report.issues) byType.set(issue.issueType, (byType.get(issue.issueType) ?? 0) + 1);

	const issues = report.issues.filter(
		(issue) =>
			(type === "all" || issue.issueType === type) &&
			(!q ||
				issue.message.toLowerCase().includes(q) ||
				issue.file.toLowerCase().includes(q) ||
				issue.key.toLowerCase().includes(q) ||
				(issue.text ?? "").toLowerCase().includes(q) ||
				(issue.proposedKey ?? "").toLowerCase().includes(q) ||
				issue.locale?.toLowerCase().includes(q)),
	);
	// The same string twice on a line is one card.
	const unique = [...new Map(issues.map((issue) => [issueId(issue), issue])).values()];
	const coverage = Object.entries(report.coverageByLocale);
	const errors = report.issues.filter((i) => i.severity === "error").length;

	return (
		<>
			<Stats>
				<Stat label={t("issues")} value={report.issues.length} tone={report.issues.length ? "amber" : "green"} />
				<Stat label={t("severity.error")} value={errors} tone={errors ? "red" : "muted"} />
				<Stat label={t("filesScanned")} value={report.filesScanned} tone="blue" />
				<Stat label={t("localesTitle")} value={report.localesCompared.length} tone="violet" />
			</Stats>

			<I18nCompletenessSection report={report} projectPath={projectPath} local={local} />

			{!report.completeness?.length && coverage.length > 0 && (
				<Section kicker={t("kickers.coverage")} title={t("coverage")}>
					<div className="flex flex-wrap gap-4">
						{coverage.map(([locale, pct]) => (
							<Gauge key={locale} value={pct} tone={coverageTone(pct)} size={72} label={locale} />
						))}
					</div>
				</Section>
			)}

			<Section
				kicker={t("kickers.issues")}
				title={t("issuesTitle")}
				actions={
					<div className="relative w-64 max-w-full">
						<Search className="wp-muted pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" aria-hidden="true" />
						<Input
							type="search"
							aria-label={t("search.placeholder")}
							placeholder={t("search.placeholder")}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="h-8 pl-8 text-xs"
						/>
					</div>
				}
			>
				<div className="wp-chips mb-3">
					<Chip tone="blue" pressed={type === "all"} onClick={() => { setType("all"); setShown(PAGE_SIZE); }}>
						{t("allTypes")} <span className="font-mono">{report.issues.length}</span>
					</Chip>
					{[...byType.entries()].map(([id, count]) => (
						<Chip key={id} tone="blue" pressed={type === id} onClick={() => { setType(id); setShown(PAGE_SIZE); }}>
							{t(`issueType.${id}`, { defaultValue: id })} <span className="font-mono">{count}</span>
						</Chip>
					))}
				</div>
				{unique.length === 0 ? (
					<p className="wp-muted text-sm">{t("search.noResults")}</p>
				) : (
					<div className="grid gap-2.5">
						{unique.slice(0, shown).map((issue) => (
							<I18nIssueCard key={issueId(issue)} issue={issue} rtl={rtl} />
						))}
						{unique.length > shown && (
							<CharterButton variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
								{t("showMore", { count: unique.length - shown })}
							</CharterButton>
						)}
					</div>
				)}
			</Section>

		</>
	);
}
