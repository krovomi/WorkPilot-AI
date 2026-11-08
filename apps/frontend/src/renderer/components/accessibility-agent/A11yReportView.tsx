import { Accessibility, AlertTriangle, Play, RotateCcw, Search, Square } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSharedAnalysisReport } from "../../hooks/useSharedAnalysisReport";
import { SharedReportNote } from "../analyses/SharedReportNote";
import {
	useAccessibilityStore,
	type WcagTargetLevel,
} from "../../stores/accessibility-store";
import type { A11yReport, A11ySeverity } from "../../../shared/types/accessibility";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Section,
	Stat,
	Stats,
	type Tone,
} from "../charter";
import { Input } from "../ui/input";

const SEVERITY_TONES: Record<A11ySeverity, Tone> = {
	critical: "red",
	serious: "orange",
	moderate: "amber",
	minor: "blue",
};

const LEVELS: WcagTargetLevel[] = ["A", "AA", "AAA"];

type FilterType = "all" | "critical" | "serious" | "passed";

interface A11yReportViewProps {
	readonly projectPath?: string;
}

/** WCAG checks over every markup the project ships (HTML, JSX, Vue, Razor, Blade…). */
export function A11yReportView({ projectPath }: A11yReportViewProps): React.ReactElement {
	const { t } = useTranslation(["accessibility", "navigation"]);

	const phase = useAccessibilityStore((s) => s.phase);
	const status = useAccessibilityStore((s) => s.status);
	const report = useAccessibilityStore((s) => s.report);
	const error = useAccessibilityStore((s) => s.error);
	const targetLevel = useAccessibilityStore((s) => s.targetLevel);
	const setTargetLevel = useAccessibilityStore((s) => s.setTargetLevel);
	const startScan = useAccessibilityStore((s) => s.startScan);
	const cancelScan = useAccessibilityStore((s) => s.cancelScan);
	const reset = useAccessibilityStore((s) => s.reset);
	const setReport = useAccessibilityStore((s) => s.setReport);

	const isScanning = phase === "scanning";
	// A server project's last report, saved on the server by any member.
	const shared = useSharedAnalysisReport("accessibility", projectPath, setReport, isScanning);

	return (
		<ModuleStage scroll="page" data-testid="accessibility-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("accessibility:title")}
				description={t("accessibility:description")}
				icon={Accessibility}
				tone="violet"
				actions={
					<>
						{report && !isScanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("accessibility:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelScan()}>
								{t("accessibility:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("accessibility:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				<div className="flex flex-wrap items-center gap-2">
					<span className="wp-kicker">{t("accessibility:levels.label")}</span>
					{LEVELS.map((level) => (
						<Chip
							key={level}
							tone="violet"
							dot={false}
							pressed={targetLevel === level}
							onClick={isScanning ? undefined : () => setTargetLevel(level)}
						>
							{t("accessibility:wcagLevel", { level })}
						</Chip>
					))}
					{!isScanning && <SharedReportNote saved={shared} />}
				</div>
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("accessibility:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("accessibility:actions.scanning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("accessibility:errors.failed", { error })}
					</Notice>
				)}
				{report ? (
					<ReportBody report={report} />
				) : (
					phase === "idle" && (
						<EmptyStage icon={Accessibility} title={t("accessibility:emptyTitle")} tone="violet">
							{t("accessibility:noData")}
						</EmptyStage>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

function ReportBody({ report }: { readonly report: A11yReport }): React.ReactElement {
	const { t } = useTranslation("accessibility");
	const [filter, setFilter] = useState<FilterType>("all");
	const [query, setQuery] = useState("");
	const q = query.toLowerCase();

	const critical = report.violations.filter((v) => v.severity === "critical").length;
	const serious = report.violations.filter((v) => v.severity === "serious").length;

	const violations = report.violations.filter(
		(v) =>
			(filter === "all" || v.severity === filter) &&
			(!q ||
				v.description.toLowerCase().includes(q) ||
				v.ruleId.toLowerCase().includes(q) ||
				v.file.toLowerCase().includes(q)),
	);
	const passed = report.passedRules.filter((rule) => !q || rule.toLowerCase().includes(q));

	const filters: ReadonlyArray<{ id: FilterType; label: string; count: number; tone: Tone }> = [
		{ id: "all", label: t("stats.violations"), count: report.violations.length, tone: "violet" },
		{ id: "critical", label: t("stats.critical"), count: critical, tone: "red" },
		{ id: "serious", label: t("stats.serious"), count: serious, tone: "orange" },
		{ id: "passed", label: t("stats.rulesPassed"), count: report.passedRules.length, tone: "green" },
	];

	return (
		<>
			<Stats>
				<Stat label={t("stats.violations")} value={report.violations.length} tone={report.violations.length ? "red" : "green"} />
				<Stat label={t("stats.critical")} value={critical} tone={critical ? "red" : "muted"} />
				<Stat label={t("stats.serious")} value={serious} tone={serious ? "orange" : "muted"} />
				<Stat label={t("stats.rulesPassed")} value={report.passedRules.length} tone="green" />
			</Stats>
			<p className="wp-meta">
				{t("targetInfo", { targetLevel: report.targetLevel, filesScanned: report.filesScanned })}
			</p>

			<Section
				kicker={t("kickers.findings")}
				title={t("findingsTitle")}
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
					{filters.map((f) => (
						<Chip key={f.id} tone={f.tone} pressed={filter === f.id} onClick={() => setFilter(f.id)}>
							{f.label} <span className="font-mono">{f.count}</span>
						</Chip>
					))}
				</div>
				<div className="grid gap-2.5">
					{filter === "passed"
						? passed.map((rule) => (
								<Panel key={`passed-${rule}`} rail tone="green" className="text-sm">
									{rule}
								</Panel>
							))
						: violations.map((v) => (
								<Panel key={`${v.ruleId}-${v.file}-${v.line}`} rail tone={SEVERITY_TONES[v.severity]}>
									<div className="flex flex-wrap items-center gap-2">
										<Chip tone={SEVERITY_TONES[v.severity]}>
											{t(`severities.${v.severity}`, { defaultValue: v.severity })}
										</Chip>
										<span className="wp-meta font-mono">
											{v.ruleId} · {t("wcagCriterion", { criterion: v.wcagCriteria })}
										</span>
									</div>
									<p className="mt-1.5 text-sm">{v.description}</p>
									<p className="wp-meta mt-1 font-mono">
										{v.file}:{v.line}
									</p>
									{v.suggestion && <p className="wp-tone-green wp-ink mt-1 text-xs">{v.suggestion}</p>}
								</Panel>
							))}
					{filter !== "passed" && violations.length === 0 && (
						<p className="wp-muted text-sm">{t("noMatches")}</p>
					)}
				</div>
			</Section>

			{report.summary && <Notice tone="violet" icon={Accessibility}>{report.summary}</Notice>}
		</>
	);
}
