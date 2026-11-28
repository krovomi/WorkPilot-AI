/**
 * A metric's weekly medians in "How you compare", the oldest first: a line
 * through the weeks that built a spec, nothing for the others.
 */

const WIDTH = 72;
const HEIGHT = 18;

/** The polyline's points, scaled to the box; null when fewer than two weeks count. */
export function sparklinePoints(values: readonly (number | null)[]): string | null {
	const known = values.flatMap((value, index) => (value === null ? [] : [{ value, index }]));
	if (known.length < 2) return null;
	const low = Math.min(...known.map((p) => p.value));
	const high = Math.max(...known.map((p) => p.value));
	const span = high - low || 1;
	// Two known weeks or more: the series has two points or more.
	const step = WIDTH / (values.length - 1);
	return known
		.map((p) => {
			const x = p.index * step;
			const y = HEIGHT - 2 - ((p.value - low) / span) * (HEIGHT - 4);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}

interface CompareSparklineProps {
	readonly values: readonly (number | null)[];
	readonly label: string;
}

export function CompareSparkline({ values, label }: CompareSparklineProps) {
	const points = sparklinePoints(values);
	if (!points) return <span className="wp-meta">—</span>;
	return (
		<svg
			width={WIDTH}
			height={HEIGHT}
			viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
			role="img"
			aria-label={label}
			className="text-primary"
		>
			<polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
		</svg>
	);
}
