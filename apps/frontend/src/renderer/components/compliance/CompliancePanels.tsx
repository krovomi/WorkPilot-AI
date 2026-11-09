/**
 * The parts of a compliance report (#357): the executive summary, the gaps
 * and their recommendations, the evidence of each control, the saved reports
 * and the export, all worded in the app's language (a framework's own titles
 * come in English and French from its YAML).
 */
import { AlertTriangle, CalendarClock, Download, FileText } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
	ComplianceExportDocument,
	ComplianceExportFormat,
	ComplianceReport,
	ComplianceReportListing,
	ControlStatus,
	EvidenceKind,
	Words,
} from "../../../shared/types/compliance";
import { formatAppDate, formatAppDateTime } from "../../lib/date-format";
import { CharterButton, Chip, Chips, Notice, Panel, Section, type Tone } from "../charter";

export const STATUS_TONES: Record<ControlStatus, Tone> = {
	covered: "green",
	failing: "red",
	stale: "amber",
	missing: "red",
};

/** A framework's own words, in the app's language when it has them. */
export function word(words: Words | undefined, language: string): string {
	if (!words) return "";
	return (language.startsWith("fr") ? words.fr : words.en) ?? words.en ?? words.fr ?? "";
}

function kinds(t: TFunction, list: EvidenceKind[]): string {
	return list.map((k) => t(`kinds.${k}`, { defaultValue: k })).join(", ");
}

export function summaryLines(t: TFunction, report: ComplianceReport): string[] {
	const s = report.summary;
	return [
		t("summary.line", {
			covered: s.covered,
			controls: s.controls,
			percent: report.coveragePercent,
			gaps: report.gaps.length,
			alerts: s.alerts,
		}),
		t("summary.activity", {
			evidence: s.evidence,
			tasks: s.tasks,
			approvals: s.specApprovals,
			reviewsApproved: s.reviewsApproved,
			reviewsRejected: s.reviewsRejected,
			testsPassed: s.testsPassed,
			testsFailed: s.testsFailed,
			securityFindings: s.securityFindings,
		}),
		report.risks.length ? t("summary.risks", { list: report.risks.join(", ") }) : t("summary.noRisk"),
	];
}

export function SummaryCard({ report }: { readonly report: ComplianceReport }): React.ReactElement {
	const { t } = useTranslation("compliance");
	const tone: Tone = report.risks.length ? "red" : report.gaps.length ? "amber" : "green";
	return (
		<Section
			kicker={t("summary.kicker")}
			title={t("summary.title", { framework: report.framework.name, period: report.period.label })}
			meta={formatAppDateTime(report.generatedAt)}
		>
			<Notice tone={tone} icon={FileText}>
				{summaryLines(t, report).map((line) => (
					<p key={line}>{line}</p>
				))}
			</Notice>
		</Section>
	);
}

export function GapsSection({ report }: { readonly report: ComplianceReport }): React.ReactElement | null {
	const { t, i18n } = useTranslation("compliance");
	if (report.gaps.length === 0) return null;
	return (
		<Section kicker={t("gaps.kicker")} title={t("gaps.title")}>
			<div className="grid gap-2.5 lg:grid-cols-2">
				{report.gaps.map((gap) => (
					<Panel key={gap.controlId} rail tone={STATUS_TONES[gap.status]}>
						<div className="flex items-start justify-between gap-2">
							<span className="wp-title text-sm">
								<span className="wp-mono">{gap.controlId}</span> · {word(gap.title, i18n.language)}
							</span>
							<Chips>
								{gap.alert && <Chip tone="red">{t("gaps.alert")}</Chip>}
								<Chip tone={STATUS_TONES[gap.status]}>{t(`statuses.${gap.status}`)}</Chip>
							</Chips>
						</div>
						<p className="wp-meta mt-1">
							{gap.ageDays === null ? t("gaps.never") : t("gaps.age", { days: gap.ageDays })} ·{" "}
							{t("gaps.needs", { kinds: kinds(t, gap.missingKinds) })}
						</p>
						{word(gap.recommendation, i18n.language) && (
							<p className="mt-1.5 text-xs">{word(gap.recommendation, i18n.language)}</p>
						)}
					</Panel>
				))}
			</div>
		</Section>
	);
}

export function ControlsSection({ report }: { readonly report: ComplianceReport }): React.ReactElement {
	const { t, i18n } = useTranslation("compliance");
	return (
		<Section kicker={t("controls.kicker")} title={t("controls.title")}>
			<div className="flex flex-col gap-2">
				{report.controls.map((control) => (
					<details key={control.id} className="wp-card wp-card-pad">
						<summary className="flex cursor-pointer items-center justify-between gap-2">
							<span className="wp-title truncate text-sm">
								<span className="wp-mono">{control.id}</span> · {word(control.title, i18n.language)}
							</span>
							<Chips>
								<Chip tone="muted">{t("controls.inPeriod", { count: control.periodCount })}</Chip>
								<Chip tone={STATUS_TONES[control.status]}>{t(`statuses.${control.status}`)}</Chip>
							</Chips>
						</summary>
						<p className="wp-meta mt-1">
							{control.checks.map((c) => kinds(t, c.kinds)).join(" + ")} ·{" "}
							{t("controls.maxAge", { days: control.maxAgeDays })}
						</p>
						{control.evidence.length === 0 ? (
							<p className="wp-meta mt-1">{t("controls.none")}</p>
						) : (
							<ul className="mt-1.5 flex flex-col gap-1 text-xs">
								{control.evidence.map((e) => (
									<li key={`${e.source}-${e.at}-${e.title}`} className="flex items-center justify-between gap-2">
										<span className="min-w-0 truncate" title={e.source}>
											{formatAppDate(e.at)} · {t(`kinds.${e.kind}`, { defaultValue: e.kind })} · {e.title}
											{e.actor ? ` · ${e.actor}` : ""}
										</span>
										<Chip tone={e.outcome === "fail" ? "red" : e.outcome === "pass" ? "green" : "muted"}>
											{t(`outcomes.${e.outcome}`)}
										</Chip>
									</li>
								))}
							</ul>
						)}
					</details>
				))}
			</div>
		</Section>
	);
}

export function SavedReports({
	reports,
	onOpen,
}: {
	readonly reports: ComplianceReportListing[];
	readonly onOpen: (name: string) => void;
}): React.ReactElement | null {
	const { t } = useTranslation("compliance");
	if (reports.length === 0) return null;
	return (
		<Section kicker={t("saved.kicker")} title={t("saved.title")}>
			<div className="flex flex-col gap-1.5">
				{reports.map((r) => (
					<button
						type="button"
						key={r.name}
						onClick={() => onOpen(r.name)}
						className="wp-card wp-card-pad flex items-center justify-between gap-2 text-left text-sm"
					>
						<span className="flex items-center gap-2">
							<CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
							<span className="wp-mono">{r.period}</span>
							<span>{r.framework}</span>
						</span>
						<Chips>
							{r.alerts > 0 && <Chip tone="red">{t("gaps.alert")}</Chip>}
							<Chip tone={r.gaps ? "amber" : "green"}>
								{t("saved.row", { coverage: r.coveragePercent ?? 0, gaps: r.gaps })}
							</Chip>
						</Chips>
					</button>
				))}
			</div>
		</Section>
	);
}

/** The report worded for CSV, HTML and PDF; main escapes every string. */
export function exportDocument(t: TFunction, language: string, report: ComplianceReport): ComplianceExportDocument {
	const col = (k: string) => t(`export.columns.${k}`);
	const evidence = report.controls.flatMap((c) =>
		c.evidence.map((e) => [
			c.id,
			t(`kinds.${e.kind}`, { defaultValue: e.kind }),
			formatAppDateTime(e.at),
			e.title,
			e.source,
			t(`outcomes.${e.outcome}`),
			e.actor ?? "",
		]),
	);
	return {
		title: t("export.title", { framework: report.framework.name, period: report.period.label }),
		summary: [
			t("export.generated", {
				date: formatAppDateTime(report.generatedAt),
				framework: report.framework.name,
				version: report.framework.version,
			}),
			...summaryLines(t, report),
		],
		tables: [
			{
				title: t("export.controlsTitle"),
				columns: [col("control"), col("title"), col("status"), col("last"), col("count")],
				rows: report.controls.map((c) => [
					c.id,
					word(c.title, language),
					t(`statuses.${c.status}`),
					c.lastEvidenceAt ? formatAppDate(c.lastEvidenceAt) : "—",
					String(c.periodCount),
				]),
			},
			{
				title: t("export.gapsTitle"),
				columns: [col("control"), col("status"), col("needs"), col("recommendation")],
				rows: report.gaps.map((g) => [
					`${g.controlId} · ${word(g.title, language)}`,
					t(`statuses.${g.status}`),
					kinds(t, g.missingKinds),
					word(g.recommendation, language),
				]),
			},
			{
				title: t("export.evidenceTitle"),
				columns: [col("control"), col("kind"), col("date"), col("what"), col("source"), col("outcome"), col("actor")],
				rows: evidence,
			},
		],
	};
}

const FORMATS: ComplianceExportFormat[] = ["pdf", "csv", "json", "html"];

export function ExportButtons({ report }: { readonly report: ComplianceReport }): React.ReactElement {
	const { t, i18n } = useTranslation("compliance");
	const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
	const save = async (format: ComplianceExportFormat) => {
		setNotice(null);
		try {
			const path = await globalThis.electronAPI.exportComplianceReport({
				format,
				language: i18n.language.slice(0, 2),
				document: exportDocument(t, i18n.language, report),
			});
			if (path) setNotice({ tone: "green", text: t("export.saved", { path }) });
		} catch (err) {
			setNotice({ tone: "red", text: t("export.failed", { error: err instanceof Error ? err.message : String(err) }) });
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="wp-kicker">{t("export.label")}</span>
				{FORMATS.map((format) => (
					<CharterButton key={format} size="sm" variant="ghost" icon={Download} onClick={() => save(format)}>
						{t(`export.${format}`)}
					</CharterButton>
				))}
			</div>
			{notice && (
				<Notice tone={notice.tone} icon={notice.tone === "red" ? AlertTriangle : undefined} role="status">
					{notice.text}
				</Notice>
			)}
		</div>
	);
}
