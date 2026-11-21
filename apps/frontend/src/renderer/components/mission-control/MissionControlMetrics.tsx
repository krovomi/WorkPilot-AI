/**
 * What past Mission Control sessions measured (#344): how many started from
 * an auto-composed crew, the tokens of an auto session against a manual one,
 * the rebalancings per session and how often a budget was exceeded.
 */

import { BarChart3 } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { appDateLocale } from "../../lib/date-format";
import { useMissionControlStore } from "../../stores/mission-control-store";
import { Section, Stat, Stats } from "../charter";

export function MissionControlMetrics() {
	const { t } = useTranslation("missionControl");
	const metrics = useMissionControlStore((s) => s.metrics);
	const fetchMetrics = useMissionControlStore((s) => s.fetchMetrics);

	useEffect(() => {
		void fetchMetrics();
	}, [fetchMetrics]);

	if (!metrics || metrics.sessions === 0) return null;
	const none = t("metrics.none");
	const percent = (value: number | null) =>
		value === null ? none : t("metrics.percent", { value: Math.round(value * 100) });
	const tokens = (value: number | null) =>
		value === null ? none : Math.round(value).toLocaleString(appDateLocale());
	const delta =
		metrics.delta_tokens === null
			? none
			: t("metrics.delta", {
					value: `${metrics.delta_tokens > 0 ? "+" : ""}${tokens(metrics.delta_tokens)}`,
				});

	return (
		<Section
			kicker={t("metrics.kicker")}
			title={t("metrics.title")}
			meta={t("metrics.sessions", { count: metrics.sessions })}
			actions={<BarChart3 className="h-4 w-4" aria-hidden="true" />}
		>
			<div data-testid="mission-control-metrics">
				<Stats>
					<Stat label={t("metrics.autoShare")} value={percent(metrics.auto_share)} tone="violet" />
					<Stat
						label={t("metrics.tokensAutoManual")}
						value={t("metrics.tokensPair", {
							auto: tokens(metrics.avg_tokens_auto),
							manual: tokens(metrics.avg_tokens_manual),
							delta,
						})}
						tone="blue"
					/>
					<Stat
						label={t("metrics.estimateRatio")}
						value={
							metrics.estimate_ratio === null
								? none
								: t("metrics.ratio", { value: metrics.estimate_ratio.toFixed(2) })
						}
						tone="green"
					/>
					<Stat
						label={t("metrics.rebalances")}
						value={
							metrics.rebalances_per_session === null
								? none
								: metrics.rebalances_per_session.toFixed(2)
						}
						tone="orange"
					/>
					<Stat label={t("metrics.overrun")} value={percent(metrics.overrun_rate)} tone="red" />
				</Stats>
			</div>
		</Section>
	);
}
