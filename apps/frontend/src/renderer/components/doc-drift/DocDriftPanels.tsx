/**
 * The parts of the drift page added by #354: each gap worded in the app's
 * language, the freshness of each document, the one-click fixes (made on a
 * review card, never in the project folder) and the JSON / HTML export.
 */
import { CheckCircle2, Download, GitBranch, Leaf } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DocDriftExportFormat, DriftIssue, DriftReport } from "../../../shared/types/doc-drift";
import { useDocDriftStore } from "../../stores/doc-drift-store";
import { CharterButton, Chip, Chips, Notice, StepCard, type Tone } from "../charter";

/** The sentence for one gap, from its type and the values the scan gave. */
export function issueMessage(t: TFunction, issue: DriftIssue): string {
	const params = issue.params ?? {};
	const base = `types.${issue.driftType}`;
	let key = `${base}.message`;
	if (issue.driftType === "signature_mismatch") key = params.old ? `${base}.message_renamed` : `${base}.message_removed`;
	if (issue.driftType === "example_syntax" && params.kind === "invalid_json") key = `${base}.message_json`;
	return t(key, { ...params, symbol: issue.referencedSymbol, defaultValue: issue.message });
}

/** What to do about one gap. */
export function issueFix(t: TFunction, issue: DriftIssue): string {
	if (issue.driftType === "stale_reference" && issue.params?.target) {
		return t("types.stale_reference.fixMoved", { target: issue.params.target });
	}
	return t(`types.${issue.driftType}.fix`, { defaultValue: issue.suggestion });
}

function scoreTone(score: number): Tone {
	if (score >= 80) return "green";
	return score >= 50 ? "amber" : "red";
}

export function FreshnessCard({ report }: { readonly report: DriftReport }): React.ReactElement | null {
	const { t } = useTranslation("docDrift");
	const freshness = report.freshness ?? [];
	if (report.averageFreshness == null || freshness.length === 0) return null;
	const worst = freshness.filter((f) => f.score < 100).slice(0, 5);
	return (
		<StepCard
			index={4}
			kicker={t("freshness.kicker")}
			title={t("freshness.average", { score: report.averageFreshness })}
			tone={scoreTone(report.averageFreshness)}
			status={<Leaf className="h-3.5 w-3.5" style={{ color: "var(--wp-tone)" }} aria-hidden="true" />}
			meta={report.git === false ? t("freshness.noGit") : undefined}
		>
			{worst.length > 0 && (
				<div className="mt-1.5 flex flex-col gap-1">
					<span className="wp-kicker wp-faint">{t("freshness.worst")}</span>
					{worst.map((f) => (
						<div key={f.docFile} className="flex items-center justify-between gap-2 text-xs">
							<span className="wp-mono truncate" title={f.docFile}>
								{f.docFile}
							</span>
							<Chips>
								{f.locale && <Chip tone="muted">{f.locale}</Chip>}
								<Chip tone={scoreTone(f.score)}>{t("freshness.score", { score: f.score })}</Chip>
							</Chips>
						</div>
					))}
				</div>
			)}
		</StepCard>
	);
}

/** The fixes the scan can make, ticked on the gaps, made together on a review card. */
export function DocDriftFixBar({
	report,
	projectPath,
	local,
}: {
	readonly report: DriftReport;
	readonly projectPath?: string;
	readonly local: boolean;
}): React.ReactElement | null {
	const { t } = useTranslation("docDrift");
	const selected = useDocDriftStore((s) => s.selectedFixes);
	const selectFixes = useDocDriftStore((s) => s.selectFixes);
	const applyFixes = useDocDriftStore((s) => s.applyFixes);
	const fixing = useDocDriftStore((s) => s.fixing);
	const outcome = useDocDriftStore((s) => s.fixOutcome);
	const fixError = useDocDriftStore((s) => s.fixError);
	const fixable = report.issues.filter((i) => i.fixId).map((i) => i.fixId as string);
	if (fixable.length === 0 && !outcome && !fixError) return null;
	return (
		<div className="flex flex-col gap-2">
			{fixable.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="wp-meta">{t("fix.available", { count: fixable.length })}</span>
					<CharterButton size="sm" variant="ghost" onClick={() => selectFixes(selected.length ? [] : fixable)}>
						{selected.length ? t("actions.reset") : t("all")}
					</CharterButton>
					<CharterButton
						size="sm"
						variant="primary"
						icon={GitBranch}
						busy={fixing}
						disabled={!local || !projectPath || selected.length === 0 || fixing}
						title={local ? undefined : t("fix.serverOnly")}
						onClick={() => projectPath && applyFixes(projectPath)}
					>
						{fixing ? t("fix.running") : t("fix.apply", { count: selected.length })}
					</CharterButton>
				</div>
			)}
			{!local && fixable.length > 0 && <p className="wp-meta">{t("fix.serverOnly")}</p>}
			{outcome && (
				<Notice tone={outcome.review ? "green" : "amber"} icon={CheckCircle2} role="status">
					{outcome.review
						? t("fix.done", { count: outcome.applied.length, branch: outcome.review.branch })
						: t("fix.nothing")}
					{outcome.missing.length > 0 && ` ${t("fix.missing", { count: outcome.missing.length })}`}
				</Notice>
			)}
			{fixError && (
				<Notice tone="red" role="alert">
					{t("fix.failed", { error: fixError })}
				</Notice>
			)}
		</div>
	);
}

/** The HTML page worded here, in the app's language; main escapes every string. */
export function exportDocument(t: TFunction, report: DriftReport) {
	const col = (k: string) => t(`export.columns.${k}`);
	const fcol = (k: string) => t(`export.freshnessColumns.${k}`);
	return {
		title: t("export.title"),
		summary: t("export.summary", {
			docs: report.docsScanned,
			issues: report.issues.length,
			score: report.averageFreshness ?? "—",
		}),
		tables: [
			{
				title: t("issues.kicker"),
				columns: [col("severity"), col("type"), col("where"), col("what"), col("fix")],
				rows: report.issues.map((i) => [
					t(i.severity),
					t(`types.${i.driftType}.label`, { defaultValue: i.driftType }),
					`${i.docFile}:${i.docLine}`,
					issueMessage(t, i),
					issueFix(t, i),
				]),
			},
			{
				title: t("export.freshnessTitle"),
				columns: [fcol("doc"), fcol("score"), fcol("locale"), fcol("issues")],
				rows: (report.freshness ?? []).map((f) => [f.docFile, String(f.score), f.locale, String(f.issues)]),
			},
		],
	};
}

export function DocDriftExportButtons({ report }: { readonly report: DriftReport }): React.ReactElement {
	const { t } = useTranslation("docDrift");
	const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
	const save = async (format: DocDriftExportFormat) => {
		setNotice(null);
		try {
			const path = await globalThis.electronAPI.exportDocDrift({
				format,
				report,
				document: exportDocument(t, report),
			});
			if (path) setNotice({ tone: "green", text: t("export.saved", { path }) });
		} catch (err) {
			setNotice({ tone: "red", text: t("export.failed", { error: err instanceof Error ? err.message : String(err) }) });
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap gap-2">
				<CharterButton size="sm" variant="ghost" icon={Download} onClick={() => save("json")}>
					{t("export.json")}
				</CharterButton>
				<CharterButton size="sm" variant="ghost" icon={Download} onClick={() => save("html")}>
					{t("export.html")}
				</CharterButton>
			</div>
			{notice && (
				<Notice tone={notice.tone} role="status">
					{notice.text}
				</Notice>
			)}
		</div>
	);
}
