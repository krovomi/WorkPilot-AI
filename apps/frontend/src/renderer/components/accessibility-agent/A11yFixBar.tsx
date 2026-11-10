import { CheckCircle2, GitBranch, Wand2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { A11yReport } from "../../../shared/types/accessibility";
import { useAccessibilityStore } from "../../stores/accessibility-store";
import { CharterButton, Notice } from "../charter";

interface Props {
	readonly report: A11yReport;
	readonly projectPath?: string;
	/** A server project has no folder here: its fixes cannot be made from this computer. */
	readonly local: boolean;
}

/**
 * The one-click fixes: ticked on the violations, made together on a review
 * card (a worktree and its own branch), never in the project folder (#391).
 */
export function A11yFixBar({ report, projectPath, local }: Props): React.ReactElement | null {
	const { t, i18n } = useTranslation("accessibility");
	const selected = useAccessibilityStore((s) => s.selectedFixes);
	const selectFixes = useAccessibilityStore((s) => s.selectFixes);
	const applyFixes = useAccessibilityStore((s) => s.applyFixes);
	const fixing = useAccessibilityStore((s) => s.fixing);
	const outcome = useAccessibilityStore((s) => s.fixOutcome);
	const fixError = useAccessibilityStore((s) => s.fixError);
	const [aiAlt, setAiAlt] = useState(false);

	const fixable = report.violations.filter((v) => v.fixId && v.fix).map((v) => v.fixId as string);
	if (fixable.length === 0 && !outcome) return null;
	const altSelected = selected.some((id) => id.startsWith("img-alt"));

	return (
		<div className="space-y-2">
			{fixable.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="wp-meta">{t("fix.available", { count: fixable.length })}</span>
					<CharterButton size="sm" variant="ghost" onClick={() => selectFixes(selected.length ? [] : fixable)}>
						{selected.length ? t("fix.clear") : t("fix.selectAll")}
					</CharterButton>
					{altSelected && (
						<label className="flex items-center gap-1.5 text-xs">
							<input type="checkbox" checked={aiAlt} onChange={(e) => setAiAlt(e.target.checked)} />
							<Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
							{t("fix.aiAlt")}
						</label>
					)}
					<CharterButton
						size="sm"
						variant="primary"
						icon={GitBranch}
						busy={fixing}
						disabled={!local || !projectPath || selected.length === 0 || fixing}
						onClick={() => projectPath && applyFixes(projectPath, i18n.language.split("-")[0] || "en", aiAlt)}
						title={local ? undefined : t("fix.serverOnly")}
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
