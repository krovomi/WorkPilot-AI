import { useTranslation } from "react-i18next";
import type { DebtTrendPoint } from "../../../preload/api/modules/tech-debt-api";

interface Props {
	readonly trend: DebtTrendPoint[];
}

export function DebtTrendChart({ trend }: Props) {
	const { t } = useTranslation(["techDebt"]);
	if (!trend.length) {
		return (
			<p className="wp-meta py-4 text-center">
				{t("techDebt:noTrend")}
			</p>
		);
	}
	const max = Math.max(...trend.map((p) => p.total_items), 1);
	const width = 400;
	const height = 120;
	const y = (p: DebtTrendPoint) => height - (p.total_items / max) * (height - 10) - 5;
	// A single scan draws a flat line across the chart rather than an invisible point.
	const points =
		trend.length === 1
			? `0,${y(trend[0])} ${width},${y(trend[0])}`
			: trend.map((p, i) => `${(i * width) / (trend.length - 1)},${y(p)}`).join(" ");
	const first = trend[0];
	const last = trend[trend.length - 1];
	const delta = last.total_items - first.total_items;
	return (
		<div>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				className="h-32 w-full text-primary"
				aria-label={t("techDebt:trendAria")}
				role="img"
			>
				<polyline
					points={points}
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
				/>
			</svg>
			<div className="wp-meta mt-1 flex justify-between">
				<span>
					{t("techDebt:trendFrom", {
						count: first.total_items,
					})}
				</span>
				<span>
					{t("techDebt:trendTo", {
						count: last.total_items,
						delta: delta >= 0 ? `+${delta}` : String(delta),
					})}
				</span>
			</div>
		</div>
	);
}
