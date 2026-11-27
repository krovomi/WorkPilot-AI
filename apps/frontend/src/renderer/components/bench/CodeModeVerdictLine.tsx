import { useTranslation } from "react-i18next";
import type { BenchManifest } from "../../../shared/types/bench";
import { codeModeVerdict } from "../../../shared/utils/bench-code-mode";
import { dollars, minutes } from "./format";

/** What code mode changed in a bench run, card by card against its twin arm. */
export function CodeModeVerdictLine({ run }: { run: BenchManifest }) {
	const { t } = useTranslation("bench");
	const verdict = codeModeVerdict(run);
	if (!verdict) return null;
	return (
		<div className="wp-card wp-card-pad wp-rail wp-tone-violet space-y-1 text-xs">
			<p className="font-semibold">{t("run.codeMode.title")}</p>
			{verdict.pairs > 0 && (
				<p>
					{t("run.codeMode.summary", {
						without: verdict.withoutResolved,
						with: verdict.withResolved,
						pairs: verdict.pairs,
						regressions: verdict.regressions,
					})}
				</p>
			)}
			{verdict.withoutCostUsd !== null && verdict.withCostUsd !== null && (
				<p>
					{t("run.codeMode.cost", {
						without: dollars(verdict.withoutCostUsd),
						with: dollars(verdict.withCostUsd),
					})}
				</p>
			)}
			{verdict.withoutDurationS !== null && verdict.withDurationS !== null && (
				<p>
					{t("run.codeMode.duration", {
						without: minutes(verdict.withoutDurationS),
						with: minutes(verdict.withDurationS),
					})}
				</p>
			)}
			<p className={verdict.verdict === "worse" ? "text-destructive" : undefined}>
				{t(`run.codeMode.${verdict.verdict}`)}
			</p>
		</div>
	);
}
