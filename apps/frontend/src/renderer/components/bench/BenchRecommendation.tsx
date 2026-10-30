/**
 * The engine the repo bench recommends per kind of card (`bench/results.py`):
 * a list in the bench view, and a hint on a card's engine step that the
 * person applies or ignores. Nothing changes an engine on its own.
 */

import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { THINKING_LEVELS } from "../../../shared/constants/models";
import type {
	BenchRecommendation,
	BenchRecommendations,
	EngineTrio,
	ThinkingLevel,
} from "../../../shared/types";
import { Button } from "../ui/button";
import { dollars, percent } from "./format";

/** The key the backend gives the recommendation over every card. */
export const ALL_KINDS = "*";

const EFFORTS = new Set<string>(THINKING_LEVELS.map((level) => level.value));

/** The recommendation as a task engine trio, or null for an effort the app does not know. */
export function recommendedTrio(pick: BenchRecommendation): EngineTrio | null {
	if (!EFFORTS.has(pick.effort)) return null;
	return { provider: pick.provider, model: pick.model, effort: pick.effort as ThinkingLevel };
}

/** The kind's own recommendation, else the one over every card. */
export function recommendationFor(
	recommendations: BenchRecommendations,
	kind: string | undefined,
): { pick: BenchRecommendation; scope: "kind" | "all" } | null {
	if (kind && recommendations[kind]) return { pick: recommendations[kind], scope: "kind" };
	if (recommendations[ALL_KINDS]) return { pick: recommendations[ALL_KINDS], scope: "all" };
	return null;
}

function Evidence({ pick }: { pick: BenchRecommendation }) {
	const { t } = useTranslation("bench");
	return (
		<span className="text-xs text-muted-foreground">
			{t("recommend.evidence", {
				rate: percent(pick.rate),
				resolved: pick.resolved,
				judged: pick.judged,
				cases: pick.cases,
			})}
			{" · "}
			{pick.avgCostUsd === null
				? t("recommend.costUnknown")
				: t("recommend.cost", { cost: dollars(pick.avgCostUsd) })}
		</span>
	);
}

export function BenchRecommendationList({
	recommendations,
}: {
	recommendations: BenchRecommendations;
}) {
	const { t } = useTranslation(["bench", "tasks"]);
	const kinds = Object.keys(recommendations).sort((a, b) =>
		a === ALL_KINDS ? -1 : b === ALL_KINDS ? 1 : a.localeCompare(b),
	);
	if (kinds.length === 0) {
		return <p className="text-sm text-muted-foreground">{t("bench:recommend.empty")}</p>;
	}
	return (
		<ul className="divide-y divide-border rounded-lg border border-border text-sm">
			{kinds.map((kind) => {
				const pick = recommendations[kind];
				return (
					<li key={kind} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
						<span className="w-32 shrink-0 text-muted-foreground">
							{kind === ALL_KINDS
								? t("bench:recommend.allKinds")
								: t(`tasks:kind.values.${kind}`, { defaultValue: kind })}
						</span>
						<span className="font-medium">{pick.model}</span>
						<span className="text-xs text-muted-foreground">
							{pick.provider} · {pick.effort}
						</span>
						<Evidence pick={pick} />
					</li>
				);
			})}
		</ul>
	);
}

interface HintProps {
	projectId: string;
	kind: string | undefined;
	/** Whether the engine shown is already the recommended one. */
	isCurrent: (trio: EngineTrio) => boolean;
	onUse: (trio: EngineTrio) => void;
	disabled?: boolean;
}

/** On a card's engine step: what the bench measured for cards of this kind. */
export function BenchEngineHint({ projectId, kind, isCurrent, onUse, disabled }: HintProps) {
	const { t } = useTranslation(["bench", "tasks"]);
	const [recommendations, setRecommendations] = useState<BenchRecommendations>({});

	useEffect(() => {
		let live = true;
		// Absent from the browser mock and from tests that do not stub the bench.
		window.electronAPI
			?.getBenchStatus?.(projectId)
			?.then((result) => {
				if (live && result.success && result.data) {
					setRecommendations(result.data.recommendations ?? {});
				}
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [projectId]);

	const found = recommendationFor(recommendations, kind);
	const trio = found ? recommendedTrio(found.pick) : null;
	if (!found || !trio) return null;
	const { pick, scope } = found;
	const current = isCurrent(trio);

	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
			<FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
			<span>
				{scope === "kind" && kind
					? t("bench:recommend.hintKind", {
							kind: t(`tasks:kind.values.${kind}`, { defaultValue: kind }),
						})
					: t("bench:recommend.hintAll")}{" "}
				<span className="font-medium">{pick.model}</span>{" "}
				<span className="text-xs text-muted-foreground">
					({pick.provider} · {pick.effort})
				</span>
			</span>
			<Evidence pick={pick} />
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="ml-auto"
				disabled={disabled || current}
				onClick={() => onUse(trio)}
			>
				{current ? t("bench:recommend.inUse") : t("bench:recommend.use")}
			</Button>
		</div>
	);
}
