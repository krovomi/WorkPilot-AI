import { useTranslation } from "react-i18next";
import type {
	DesignLoopIssue,
	DesignRenderLoop,
} from "../../../../shared/types/design-to-code";
import { useDesignToCodeStore } from "../../../stores/design-to-code-store";
import { PassFixLine, ResponsivePanel, SpendLine, StatesPanel } from "./LoopReport";

/** A 0..1 score as a percentage with one decimal. */
export function percent(score: number | null | undefined): string {
	return String(Math.round((score ?? 0) * 1000) / 10);
}

function IssueLine({ issue }: { issue: DesignLoopIssue }) {
	const { t } = useTranslation("designToCode");
	return (
		<li className="di-loop-issue" data-status={issue.status}>
			<span className="di-loop-status">{t(`loop.issueStatus.${issue.status}`)}</span>
			<span>
				{t(`loop.issue.${issue.kind}`, {
					region: issue.region,
					target: issue.target,
					render: issue.render,
					px: Math.abs(issue.px ?? 0),
					axis: issue.axis ? t(`loop.axis.${issue.axis}`) : "",
				})}
			</span>
		</li>
	);
}

/**
 * The render loop's report (#379): one score per iteration, the target, the
 * render and the diff map of the iteration picked, and every difference the
 * loop measured with what became of it.
 */
export function IterationPanel({ loop }: { loop: DesignRenderLoop }) {
	const { t } = useTranslation("designToCode");
	const target = useDesignToCodeStore((s) => s.imagePreview);
	const selected = useDesignToCodeStore((s) => s.selectedIteration);
	const selectIteration = useDesignToCodeStore((s) => s.selectIteration);

	if (loop.status === "skipped") {
		return (
			<div className="di-banner mb-3" role="status" data-testid="design-loop-skipped">
				<div>
					<strong>{t("loop.status.skipped")}</strong>
					<div>
						{t(`loop.reason.${loop.reason ?? "load_failed"}`, {
							provider: loop.provider || "—",
							model: loop.model || "—",
							detail: loop.detail ?? "",
						})}
					</div>
				</div>
			</div>
		);
	}

	const best = loop.iterations[loop.best_iteration];
	// A token or cost budget says which; the time budget keeps its own words.
	const statusKey =
		loop.status === "budget" && (loop.budget_kind === "tokens" || loop.budget_kind === "cost")
			? `budget_${loop.budget_kind}`
			: loop.status;
	const shown =
		loop.iterations.find((it) => it.index === selected) ?? best ?? loop.iterations[0];

	return (
		<div className="di-card di-loop mb-3 p-3" data-testid="design-loop">
			<div className="di-kicker" style={{ ["--di-accent" as string]: "var(--di-code)" }}>
				{t("loop.kicker")}
			</div>
			<strong className="di-loop-title" data-status={loop.status}>
				{t(`loop.status.${statusKey}`, { score: percent(best?.score) })}
			</strong>
			{loop.status === "failed" && loop.detail && (
				<div className="di-muted di-mono text-2xs">{loop.detail}</div>
			)}
			{loop.spend && <SpendLine spend={loop.spend} />}
			{loop.mirror && <div className="di-muted text-xs">{t("loop.mirror")}</div>}
			{Boolean(loop.missing_fonts?.length) && (
				<div className="di-muted text-xs">
					{t("loop.missingFonts", { fonts: loop.missing_fonts?.join(", ") })}
				</div>
			)}
			{Boolean(loop.masked?.length) && (
				<div className="di-muted text-xs">
					{t("loop.masked", { zones: loop.masked?.join(", ") })}
				</div>
			)}
			{Boolean(loop.drawn_masks) && (
				<div className="di-muted text-xs">{t("loop.drawnMasks", { count: loop.drawn_masks })}</div>
			)}

			<fieldset className="di-loop-strip" aria-label={t("loop.iterationsLabel")}>
				{loop.iterations.map((it) => (
					<button
						key={it.index}
						type="button"
						className="di-chip"
						aria-pressed={shown?.index === it.index}
						data-testid={`design-loop-iteration-${it.index}`}
						onClick={() => selectIteration(it.index)}
					>
						<b>{t("loop.iteration", { index: it.index })}</b>
						<span>{t("loop.score", { score: percent(it.score) })}</span>
						{it.index === 0 && <span className="di-faint">{t("loop.generated")}</span>}
						{it.index === loop.best_iteration && (
							<span className="di-loop-kept">{t("loop.kept")}</span>
						)}
					</button>
				))}
			</fieldset>

			{shown && (
				<>
					<div className="di-loop-images">
						<figure>
							{target && <img src={target} alt={t("loop.target")} />}
							<figcaption>{t("loop.target")}</figcaption>
						</figure>
						<figure>
							<img src={shown.render_image} alt={t("loop.render")} />
							<figcaption>{t("loop.render")}</figcaption>
						</figure>
						<figure>
							<img src={shown.diff_image} alt={t("loop.diff")} />
							<figcaption>{t("loop.diff")}</figcaption>
						</figure>
					</div>
					{shown.index > 0 && (
						<div className="di-muted text-xs">
							{shown.applied_edits > 0
								? t("loop.edits", { count: shown.applied_edits })
								: t("loop.noEdits")}
						</div>
					)}
				</>
			)}

			<div className="di-group-label mt-3">{t("loop.issues")}</div>
			{loop.issues.length === 0 ? (
				<div className="di-muted text-xs">{t("loop.noIssues")}</div>
			) : (
				<ul className="di-loop-issues" data-testid="design-loop-issues">
					{loop.issues.map((issue) => (
						<IssueLine key={issue.id} issue={issue} />
					))}
				</ul>
			)}
			{loop.responsive && <ResponsivePanel pass={loop.responsive} />}
			{loop.states && <StatesPanel pass={loop.states} />}
			{loop.pass_fix && <PassFixLine fix={loop.pass_fix} />}
		</div>
	);
}
