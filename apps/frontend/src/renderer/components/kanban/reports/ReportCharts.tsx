/**
 * The small inline SVG charts of the Kanban's reports: lines (burndown),
 * bars (velocity, throughput, cycle time) and stacked bands (cumulative
 * flow). Colours come from the theme's text classes (`TONES`), drawn with
 * `currentColor`; each report also carries a text table (`FigureTable`) for
 * screen readers, so a chart is never the only way to read it.
 */
import { formatAppDate } from "../../../lib/date-format";
import { cn } from "../../../lib/utils";

const WIDTH = 560;
const HEIGHT = 180;
const PAD = { top: 10, right: 8, bottom: 22, left: 28 };

/** The tones a series may take, as theme classes (stroke and fill). */
export const TONES = {
	primary: "text-primary",
	muted: "text-muted-foreground/50",
	success: "text-success",
	warning: "text-warning",
	info: "text-info",
	destructive: "text-destructive",
} as const;
export type Tone = keyof typeof TONES;

/** A day `YYYY-MM-DD` shortened for an axis, in the app's language. */
export function shortDay(day: string): string {
	return formatAppDate(`${day}T00:00:00`, { month: "short", day: "numeric" });
}

function scale(max: number) {
	const top = Math.max(1, max);
	const plotHeight = HEIGHT - PAD.top - PAD.bottom;
	return (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
}

function xAt(index: number, count: number): number {
	const plotWidth = WIDTH - PAD.left - PAD.right;
	return PAD.left + (count <= 1 ? plotWidth / 2 : (index * plotWidth) / (count - 1));
}

function Axis({ labels, max }: { labels: string[]; max: number }) {
	const y = scale(max);
	const every = Math.max(1, Math.ceil(labels.length / 6));
	return (
		<g className="text-muted-foreground" fontSize="9" fill="currentColor">
			<line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity="0.3" />
			<text x={PAD.left - 4} y={y(max) + 3} textAnchor="end">
				{Math.max(1, max)}
			</text>
			<text x={PAD.left - 4} y={y(0) + 3} textAnchor="end">
				0
			</text>
			{labels.map((label, index) =>
				index % every === 0 || index === labels.length - 1 ? (
					<text key={label} x={xAt(index, labels.length)} y={HEIGHT - 6} textAnchor="middle">
						{label}
					</text>
				) : null,
			)}
		</g>
	);
}

export interface LineSeries {
	key: string;
	label: string;
	tone: Tone;
	/** One value per label; null leaves a gap (a day still to come). */
	values: (number | null)[];
	dashed?: boolean;
}

export function LineChart({ title, labels, series }: { title: string; labels: string[]; series: LineSeries[] }) {
	const max = Math.max(0, ...series.flatMap((item) => item.values.map((value) => value ?? 0)));
	const y = scale(max);
	return (
		<figure className="space-y-2">
			<svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-48 w-full" role="img" aria-label={title}>
				<Axis labels={labels} max={max} />
				{series.map((item) => {
					const points = item.values
						.map((value, index) => (value === null ? null : `${xAt(index, labels.length)},${y(value)}`))
						.filter(Boolean)
						.join(" ");
					return (
						<polyline
							key={item.key}
							points={points}
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeDasharray={item.dashed ? "4 4" : undefined}
							className={TONES[item.tone]}
						/>
					);
				})}
			</svg>
			<Legend items={series} />
		</figure>
	);
}

export interface BarGroup {
	key: string;
	label: string;
	/** One value per series, in the series' order; null draws no bar. */
	values: (number | null)[];
}

export function BarChart({
	title,
	groups,
	series,
}: {
	title: string;
	groups: BarGroup[];
	series: { key: string; label: string; tone: Tone }[];
}) {
	const max = Math.max(0, ...groups.flatMap((group) => group.values.map((value) => value ?? 0)));
	const y = scale(max);
	const plotWidth = WIDTH - PAD.left - PAD.right;
	const slot = plotWidth / Math.max(1, groups.length);
	const bar = Math.min(28, (slot * 0.7) / series.length);
	return (
		<figure className="space-y-2">
			<svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-48 w-full" role="img" aria-label={title}>
				<Axis labels={[]} max={max} />
				{groups.map((group, groupIndex) => {
					const left = PAD.left + groupIndex * slot + (slot - bar * series.length) / 2;
					return (
						<g key={group.key}>
							{group.values.map((value, index) =>
								value === null ? null : (
									<rect
										key={series[index].key}
										x={left + index * bar}
										y={y(value)}
										width={Math.max(1, bar - 2)}
										height={y(0) - y(value)}
										rx="2"
										fill="currentColor"
										className={TONES[series[index].tone]}
									/>
								),
							)}
							<text
								x={PAD.left + groupIndex * slot + slot / 2}
								y={HEIGHT - 6}
								textAnchor="middle"
								fontSize="9"
								fill="currentColor"
								className="text-muted-foreground"
							>
								{group.label}
							</text>
						</g>
					);
				})}
			</svg>
			{series.length > 1 && <Legend items={series} />}
		</figure>
	);
}

export interface StackSeries {
	key: string;
	label: string;
	tone: Tone;
	/** One value per label. */
	values: number[];
}

/** Stacked bands, bottom first: each band's values add up on the ones below. */
export function StackedChart({ title, labels, series }: { title: string; labels: string[]; series: StackSeries[] }) {
	const totals = labels.map((_, index) => series.reduce((sum, item) => sum + item.values[index], 0));
	const y = scale(Math.max(0, ...totals));
	const below = labels.map(() => 0);
	const bands = series.map((item) => {
		const lower = [...below];
		item.values.forEach((value, index) => {
			below[index] += value;
		});
		const upper = [...below];
		const top = upper.map((value, index) => `${xAt(index, labels.length)},${y(value)}`);
		const bottom = lower.map((value, index) => `${xAt(index, labels.length)},${y(value)}`).reverse();
		return { item, points: [...top, ...bottom].join(" ") };
	});
	return (
		<figure className="space-y-2">
			<svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-48 w-full" role="img" aria-label={title}>
				<Axis labels={labels} max={Math.max(0, ...totals)} />
				{bands.map(({ item, points }) => (
					<polygon key={item.key} points={points} fill="currentColor" fillOpacity="0.7" className={TONES[item.tone]} />
				))}
			</svg>
			<Legend items={[...series].reverse()} />
		</figure>
	);
}

function Legend({ items }: { items: { key: string; label: string; tone: Tone }[] }) {
	return (
		<figcaption className="flex flex-wrap gap-3 text-xs text-muted-foreground">
			{items.map((item) => (
				<span key={item.key} className="inline-flex items-center gap-1.5">
					<span className={cn("h-2 w-2 rounded-full bg-current", TONES[item.tone])} aria-hidden="true" />
					{item.label}
				</span>
			))}
		</figcaption>
	);
}

/** The same figures as text, for a screen reader (and a person who wants the numbers). */
export function FigureTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
	return (
		<table className="sr-only">
			<caption>{caption}</caption>
			<thead>
				<tr>
					{head.map((cell) => (
						<th key={cell} scope="col">
							{cell}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={String(row[0])}>
						{row.map((cell, index) => (
							<td key={head[index]}>{cell}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}
