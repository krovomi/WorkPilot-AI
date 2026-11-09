import { AlertTriangle, CheckCircle2, GitBranch, Languages } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { I18nReport } from "../../../shared/types/i18n-agent";
import { useI18nAgentStore } from "../../stores/i18n-agent-store";
import { CharterButton, Chip, Gauge, Notice, Panel, Section, type Tone } from "../charter";

export const completenessTone = (pct: number): Tone => (pct >= 95 ? "green" : pct >= 80 ? "amber" : "red");

interface Props {
	readonly report: I18nReport;
	readonly projectPath?: string;
	/** A server project has no folder here: its catalogs cannot be written from this computer. */
	readonly local: boolean;
}

/**
 * Completeness per locale (translated keys, copies of the reference counted
 * out) and the one-click translation of the missing keys, on a review card (#346).
 */
export function I18nCompletenessSection({ report, projectPath, local }: Props): React.ReactElement | null {
	const { t } = useTranslation("i18nAgent");
	const translate = useI18nAgentStore((s) => s.translate);
	const translating = useI18nAgentStore((s) => s.translating);
	const outcome = useI18nAgentStore((s) => s.translation);
	const translateError = useI18nAgentStore((s) => s.translateError);

	const rows = report.completeness ?? [];
	if (rows.length === 0) return null;
	const translatable = Object.values(report.translatable ?? {}).reduce((n, c) => n + c, 0);

	return (
		<Section
			kicker={t("kickers.completeness")}
			title={t("completeness.title")}
			description={t("completeness.description")}
			actions={
				translatable > 0 && (
					<CharterButton
						size="sm"
						variant="primary"
						icon={GitBranch}
						busy={translating}
						disabled={!local || !projectPath || translating}
						title={local ? undefined : t("translate.serverOnly")}
						onClick={() => projectPath && translate(projectPath)}
					>
						{translating ? t("translate.running") : t("translate.action", { count: translatable })}
					</CharterButton>
				)
			}
		>
			<div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
				{rows.map((row) => (
					<Panel key={row.locale}>
						<div className="flex items-center gap-3">
							<Gauge value={row.score} tone={completenessTone(row.score)} size={64} label={row.locale} />
							<div className="min-w-0 space-y-0.5 text-xs">
								<p>{t("completeness.present", { present: row.present, total: row.total })}</p>
								{row.missing > 0 && <p className="wp-tone-red wp-ink">{t("completeness.missing", { count: row.missing })}</p>}
								{row.untranslated > 0 && (
									<p className="wp-tone-amber wp-ink">{t("completeness.untranslated", { count: row.untranslated })}</p>
								)}
								{row.rtl && (
									<Chip tone="violet" dot={false}>
										{t("completeness.rtl")}
									</Chip>
								)}
							</div>
						</div>
					</Panel>
				))}
			</div>
			{translatable > 0 && <p className="wp-meta mt-2">{local ? t("translate.note") : t("translate.serverOnly")}</p>}
			{outcome && (
				<Notice tone={outcome.review ? "green" : "amber"} icon={outcome.review ? CheckCircle2 : Languages} role="status" className="mt-2">
					{outcome.review
						? t("translate.done", { count: outcome.added, branch: outcome.review.branch })
						: outcome.answered
							? t("translate.nothing")
							: t("translate.noModel")}
					{outcome.rejected > 0 && ` ${t("translate.rejected", { count: outcome.rejected })}`}
					{outcome.skipped > 0 && ` ${t("translate.skipped", { count: outcome.skipped })}`}
					{outcome.notWritable.length > 0 &&
						` ${t("translate.notWritable", { count: outcome.notWritable.length, files: outcome.notWritable.slice(0, 3).join(", ") })}`}
				</Notice>
			)}
			{translateError && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="mt-2">
					{t("translate.failed", { error: translateError })}
				</Notice>
			)}
		</Section>
	);
}
