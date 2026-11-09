import { Download, FileText, Languages } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { A11yExportFormat, A11yHistoryEntry, A11yReport } from "../../../shared/types/accessibility";
import { formatAppDateTime } from "../../lib/date-format";
import { Bar, CharterButton, Gauge, Notice, Panel, Section, type Tone } from "../charter";

export function scoreTone(score: number): Tone {
	if (score >= 90) return "green";
	if (score >= 70) return "amber";
	return "red";
}

const EXPORTS: A11yExportFormat[] = ["html", "csv", "pdf"];

/** The score, its trend, the criteria and pages that cost it, and the exports (#391). */
export function A11yScoreSection({ report }: { readonly report: A11yReport }): React.ReactElement | null {
	const { t } = useTranslation("accessibility");
	const [exported, setExported] = useState<string | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	if (typeof report.score !== "number") return null;
	const criteria = report.criteria ?? [];
	const pages = (report.pages ?? []).slice(0, 8);
	const withoutLang = report.pagesWithoutLang ?? [];

	const exportAs = async (format: A11yExportFormat) => {
		setExportError(null);
		try {
			const path = await globalThis.electronAPI.exportAccessibilityReport({
				format,
				report,
				title: t("export.title"),
			});
			setExported(path);
		} catch (err) {
			setExportError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<Section
			kicker={t("kickers.score")}
			title={t("score.title")}
			actions={
				<div className="flex flex-wrap gap-1.5">
					{EXPORTS.map((format) => (
						<CharterButton key={format} size="sm" variant="ghost" icon={Download} onClick={() => exportAs(format)}>
							{t(`export.${format}`)}
						</CharterButton>
					))}
				</div>
			}
		>
			<div className="flex flex-wrap items-center gap-6">
				<Gauge value={report.score} tone={scoreTone(report.score)} label={String(report.score)} />
				<div className="min-w-0 flex-1 space-y-1">
					<p className="text-sm">{t("score.explain")}</p>
					<HistoryStrip history={report.history ?? []} />
				</div>
			</div>
			{exported && (
				<p className="wp-meta mt-2" role="status">
					<FileText className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
					{t("export.saved", { path: exported })}
				</p>
			)}
			{exportError && (
				<Notice tone="red" role="alert" className="mt-2">
					{t("export.failed", { error: exportError })}
				</Notice>
			)}
			{withoutLang.length > 0 && (
				<Notice tone="amber" icon={Languages} className="mt-3">
					{t("score.noLang", { count: withoutLang.length, files: withoutLang.slice(0, 3).join(", ") })}
				</Notice>
			)}
			{criteria.length > 0 && (
				<div className="mt-4 grid gap-2 md:grid-cols-2">
					{criteria.map((c) => (
						<Panel key={c.criterion} className="text-sm">
							<div className="flex items-baseline justify-between gap-2">
								<span>
									<span className="font-mono">{c.criterion}</span>{" "}
									{t(`criteria.${c.criterion}`, { defaultValue: c.name })}
								</span>
								<span className="wp-meta font-mono">
									{t("score.criterionCount", { count: c.count })} · {c.score}
								</span>
							</div>
							<Bar value={c.score} tone={scoreTone(c.score)} />
						</Panel>
					))}
				</div>
			)}
			{pages.length > 0 && (
				<div className="mt-4">
					<p className="wp-kicker mb-1.5">{t("score.pages")}</p>
					<ul className="grid gap-1 text-sm">
						{pages.map((p) => (
							<li key={p.file} className="flex items-center justify-between gap-3">
								<span className="truncate font-mono text-xs">{p.file}</span>
								<span className="wp-meta shrink-0 font-mono">
									{t("score.criterionCount", { count: p.count })} · {p.score}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</Section>
	);
}

function HistoryStrip({ history }: { readonly history: readonly A11yHistoryEntry[] }): React.ReactElement | null {
	const { t } = useTranslation("accessibility");
	if (history.length < 2) return <p className="wp-meta">{t("score.firstScan")}</p>;
	const last = history[history.length - 1];
	const previous = history[history.length - 2];
	const delta = last.score - previous.score;
	return (
		<div>
			<div className="flex h-8 items-end gap-0.5" aria-hidden="true">
				{history.map((entry) => (
					<span
						key={entry.at}
						className={`wp-tone-${scoreTone(entry.score)} w-2 rounded-sm`}
						style={{ height: `${Math.max(8, entry.score)}%`, background: "var(--wp-tone)" }}
						title={`${formatAppDateTime(entry.at, { dateStyle: "short", timeStyle: "short" })} · ${entry.score}`}
					/>
				))}
			</div>
			<p className="wp-meta">
				{delta === 0
					? t("score.trendSame", { count: history.length })
					: t(delta > 0 ? "score.trendUp" : "score.trendDown", { delta: Math.abs(delta), count: history.length })}
			</p>
		</div>
	);
}
