/**
 * A file's risk over the window, as a sparkline (#370). The points are the
 * scans the history kept; the line goes up when the risk does.
 */
import type { RiskPoint } from "@shared/types/self-healing";
import { useTranslation } from "react-i18next";

interface RiskTrajectoryChartProps {
	readonly file: string;
	readonly points: RiskPoint[];
	readonly days: number;
	readonly width?: number;
	readonly height?: number;
}

/** The polyline's points, risk 0-100 mapped to the box, oldest on the left. */
export function sparklinePoints(points: RiskPoint[], width: number, height: number): string {
	if (points.length === 0) return "";
	const times = points.map((p) => Date.parse(p.day));
	const first = Math.min(...times);
	const span = Math.max(...times) - first || 1;
	return points
		.map((p, index) => {
			const x = points.length === 1 ? width / 2 : ((times[index] - first) / span) * width;
			const y = height - (Math.min(Math.max(p.risk, 0), 100) / 100) * height;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}

export function RiskTrajectoryChart({
	file,
	points,
	days,
	width = 120,
	height = 28,
}: RiskTrajectoryChartProps) {
	const { t } = useTranslation(["selfHealing"]);
	return (
		<svg
			role="img"
			aria-label={t("selfHealing:trends.chartLabel", { file, days })}
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			className="shrink-0 text-[var(--wp-tone)]"
			data-testid="risk-sparkline"
		>
			<polyline
				fill="none"
				stroke="currentColor"
				strokeWidth={1.5}
				strokeLinejoin="round"
				points={sparklinePoints(points, width, height)}
			/>
		</svg>
	);
}
