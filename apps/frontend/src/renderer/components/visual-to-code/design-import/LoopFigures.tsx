import { useTranslation } from "react-i18next";
import { useDesignToCodeStore } from "../../../stores/design-to-code-store";
import { percent } from "./IterationPanel";

/**
 * The render loop's figures on the selected project (#379): the score the
 * loops kept, the corrections they needed to converge, and how many writes
 * reached the project as they were written. Read from the project's own
 * journals on this computer (main/design-loop-history.ts); nothing is sent.
 */
export function LoopFigures() {
	const { t } = useTranslation("designToCode");
	const stats = useDesignToCodeStore((s) => s.loopStats);
	if (!stats || (stats.loops === 0 && stats.writes === 0)) return null;
	const decided = stats.kept + stats.retouched;
	return (
		<div
			className="di-card di-fact mt-3"
			style={{ ["--di-accent" as string]: "var(--di-code)" }}
			data-testid="design-loop-figures"
		>
			<div className="di-kicker">{t("figures.kicker")}</div>
			<ul className="di-muted mt-1 space-y-0.5 text-2xs">
				{stats.loops > 0 && (
					<li>{t("figures.loops", { count: stats.loops, converged: stats.converged })}</li>
				)}
				{stats.averageScore !== null && (
					<li>{t("figures.averageScore", { score: percent(stats.averageScore) })}</li>
				)}
				{stats.loops > 0 && (
					<li>
						{stats.averageIterations === null
							? t("figures.noConvergence")
							: t("figures.averageIterations", {
									value: stats.averageIterations.toFixed(1),
								})}
					</li>
				)}
				{stats.writes > 0 && (
					<li>
						{decided > 0
							? t("figures.accepted", { kept: stats.kept, count: decided })
							: t("figures.noneDecided")}
						{stats.pending > 0 && (
							<span>
								{" · "}
								{t("figures.pending", { count: stats.pending })}
							</span>
						)}
					</li>
				)}
			</ul>
			{stats.writes > 0 && <div className="di-faint mt-1 text-3xs">{t("figures.approximation")}</div>}
			<div className="di-faint text-3xs">{t("figures.local")}</div>
		</div>
	);
}
