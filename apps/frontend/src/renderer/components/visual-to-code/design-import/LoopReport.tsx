import { useTranslation } from "react-i18next";
import type {
	DesignBreakpointCheck,
	DesignLoopSpend,
	DesignResponsivePass,
	DesignStatesPass,
} from "../../../../shared/types/design-to-code";
import { percent } from "./IterationPanel";

/** A dollar amount: cents above a cent, four decimals below. */
export function dollars(value: number): string {
	return value >= 0.01 ? value.toFixed(2) : value.toFixed(4);
}

/** What the corrections spent, and how their cost is known (#379). */
export function SpendLine({ spend }: { spend: DesignLoopSpend }) {
	const { t } = useTranslation("designToCode");
	const cost =
		spend.cost_status === "priced" && spend.cost_usd !== null
			? t("loop.spend.cost", { cost: dollars(spend.cost_usd), max: dollars(spend.max_cost_usd) })
			: t(`loop.spend.${spend.cost_status === "flat_rate" ? "flatRate" : "unknownCost"}`);
	return (
		<div className="di-muted text-xs" data-testid="design-loop-spend">
			{t(spend.estimated ? "loop.spend.tokensEstimated" : "loop.spend.tokens", {
				tokens: spend.tokens,
				max: spend.max_tokens,
			})}
			{" · "}
			{cost}
			{!spend.cost_budget_checked && spend.cost_status === "unknown" && (
				<span className="di-faint">
					{" · "}
					{t("loop.spend.costUnchecked")}
				</span>
			)}
		</div>
	);
}

function BreakpointCard({ point }: { point: DesignBreakpointCheck }) {
	const { t } = useTranslation("designToCode");
	// A finding said twice is said once.
	const findings = [
		...new Set([
		...(point.overflow_px > 0 ? [t("loop.responsive.overflow", { px: point.overflow_px })] : []),
		...point.overflowing.map((label) => t("loop.responsive.outside", { label })),
		...point.clipped.map((label) => t("loop.responsive.clipped", { label })),
		...point.overlaps.map(([a, b]) => t("loop.responsive.overlap", { a, b })),
		...(point.issues ?? []).map((issue) =>
			t(`loop.issue.${issue.kind}`, {
				region: issue.region,
				target: issue.target,
				render: issue.render,
				px: Math.abs(issue.px ?? 0),
				axis: issue.axis ? t(`loop.axis.${issue.axis}`) : "",
			}),
		),
		]),
	];
	return (
		<figure className="di-loop-breakpoint" data-testid={`design-breakpoint-${point.name}`}>
			<img src={point.render_image} alt={t(`loop.responsive.${point.name}`)} />
			<figcaption>
				<b>{t(`loop.responsive.${point.name}`)}</b>{" "}
				{t("loop.responsive.size", { width: point.width, height: point.height })}
				<div className="di-faint">
					{point.compared
						? t("loop.responsive.compared", { score: percent(point.score) })
						: t("loop.responsive.notCompared")}
				</div>
				{findings.length === 0 ? (
					<div className="di-muted">{t("loop.responsive.clean")}</div>
				) : (
					<ul className="di-loop-issues">
						{findings.map((line) => (
							<li key={line} className="di-loop-issue" data-status="open">
								{line}
							</li>
						))}
					</ul>
				)}
			</figcaption>
		</figure>
	);
}

/** The page at the mobile, tablet and desktop widths. */
export function ResponsivePanel({ pass }: { pass: DesignResponsivePass }) {
	const { t } = useTranslation("designToCode");
	return (
		<div data-testid="design-loop-responsive">
			<div className="di-group-label mt-3">{t("loop.responsive.title")}</div>
			{pass.status === "failed" ? (
				<div className="di-muted text-xs">
					{t(`loop.reason.${pass.detail || "load_failed"}`, { provider: "—", model: "—", detail: "" })}
				</div>
			) : (
				<div className="di-loop-images">
					{(pass.breakpoints ?? []).map((point) => (
						<BreakpointCard key={point.name} point={point} />
					))}
				</div>
			)}
		</div>
	);
}

function StateCell({ state, kind }: { state: { changed: boolean; image: string } | null; kind: "hover" | "focus" }) {
	const { t } = useTranslation("designToCode");
	if (!state) return <span className="di-faint">{t("loop.states.unreached")}</span>;
	return (
		<span className="di-loop-state" data-changed={state.changed}>
			<img src={state.image} alt={t(`loop.states.${kind}`)} />
			<span className={state.changed ? "di-muted" : "di-loop-warn"}>
				{t(state.changed ? "loop.states.visible" : `loop.states.none_${kind}`)}
			</span>
		</span>
	);
}

/** Hover and focus of the first interactive elements, next to their rest state. */
export function StatesPanel({ pass }: { pass: DesignStatesPass }) {
	const { t } = useTranslation("designToCode");
	const elements = pass.elements ?? [];
	return (
		<div data-testid="design-loop-states">
			<div className="di-group-label mt-3">{t("loop.states.title", { limit: pass.limit ?? 0 })}</div>
			{pass.status === "failed" ? (
				<div className="di-muted text-xs">
					{t(`loop.reason.${pass.detail || "load_failed"}`, { provider: "—", model: "—", detail: "" })}
				</div>
			) : elements.length === 0 ? (
				<div className="di-muted text-xs">{t("loop.states.noElements")}</div>
			) : (
				<>
					<div className="di-muted text-xs">
						{t("loop.states.summary", {
							hover: pass.without_hover ?? 0,
							focus: pass.without_focus ?? 0,
							unreached: pass.unreached ?? 0,
						})}
					</div>
					<ul className="di-loop-states">
						{elements.map((element) => (
							<li key={element.id}>
								<span className="di-mono text-2xs">{element.label}</span>
								<img src={element.rest_image} alt={t("loop.states.rest")} />
								<StateCell state={element.hover} kind="hover" />
								<StateCell state={element.focus} kind="focus" />
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
}
