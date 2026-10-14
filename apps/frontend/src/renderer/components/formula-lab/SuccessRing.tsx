/**
 * SuccessRing — a compact circular gauge for a 0-1 success probability.
 *
 * Pure SVG (no dependency). Colour shifts red → amber → emerald as the
 * probability climbs, so a glance conveys risk without reading the number.
 * Drawn by the shared ui/progress-ring.
 */

import { ProgressRing } from "../ui/progress-ring";

export interface SuccessRingProps {
	/** Probability in [0, 1]. */
	readonly value: number;
	/** Diameter in px. */
	readonly size?: number;
	/** Stroke width in px. */
	readonly stroke?: number;
	/** Show the percentage in the centre. */
	readonly showLabel?: boolean;
	readonly className?: string;
}

function ringColor(value: number): string {
	if (value >= 0.85) return "#10b981"; // emerald-500
	if (value >= 0.7) return "#22c55e"; // green-500
	if (value >= 0.55) return "#f59e0b"; // amber-500
	if (value >= 0.4) return "#f97316"; // orange-500
	return "#ef4444"; // red-500
}

export function SuccessRing({
	value,
	size = 40,
	stroke = 4,
	showLabel = true,
	className,
}: SuccessRingProps) {
	const clamped = Math.max(0, Math.min(1, value));
	const color = ringColor(clamped);
	const percent = Math.round(clamped * 100);

	return (
		<ProgressRing
			value={clamped * 100}
			size={size}
			stroke={stroke}
			color={color}
			className={className}
			ariaLabel={`${percent}% success`}
			label={showLabel ? percent : undefined}
			labelStyle={{ fontSize: size * 0.28, color }}
		/>
	);
}
