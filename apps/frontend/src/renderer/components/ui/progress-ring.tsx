/**
 * ProgressRing — a compact circular gauge (pure SVG, no dependency).
 *
 * Promoted from formula-lab/SuccessRing so other features can show a ring
 * (the context-window gauge, the success probability). The indicator colour
 * is either an explicit CSS colour or `currentColor` driven by a Tailwind
 * text class, and optional markers draw a radial tick at a position on the
 * ring (e.g. a threshold).
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface ProgressRingProps {
	/** Fill in [0, 100]; clamped. */
	readonly value: number;
	/** Diameter in px. */
	readonly size?: number;
	/** Stroke width in px. */
	readonly stroke?: number;
	/** Explicit indicator colour; otherwise `currentColor` (see indicatorClassName). */
	readonly color?: string;
	/** Tailwind text-* class colouring the indicator when no `color` is given. */
	readonly indicatorClassName?: string;
	readonly trackClassName?: string;
	/** Positions in [0, 100] where a radial tick is drawn. */
	readonly markers?: readonly number[];
	readonly markerClassName?: string;
	/** Centre content (a number, an icon…). */
	readonly label?: ReactNode;
	readonly labelClassName?: string;
	readonly labelStyle?: CSSProperties;
	/** Accessible name; the ring is exposed as an image when given. */
	readonly ariaLabel?: string;
	readonly className?: string;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

export function ProgressRing({
	value,
	size = 40,
	stroke = 4,
	color,
	indicatorClassName,
	trackClassName,
	markers,
	markerClassName,
	label,
	labelClassName,
	labelStyle,
	ariaLabel,
	className,
}: ProgressRingProps) {
	const clamped = clampPercent(value);
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const offset = circumference * (1 - clamped / 100);
	const center = size / 2;

	return (
		<div
			className={cn("relative shrink-0", className)}
			style={{ width: size, height: size }}
		>
			<svg
				width={size}
				height={size}
				viewBox={`0 0 ${size} ${size}`}
				role={ariaLabel ? "img" : undefined}
				aria-label={ariaLabel}
				aria-hidden={ariaLabel ? undefined : true}
			>
				<circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke="currentColor"
					strokeWidth={stroke}
					className={cn("text-muted-foreground/20", trackClassName)}
				/>
				<circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke={color ?? "currentColor"}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={offset}
					transform={`rotate(-90 ${center} ${center})`}
					className={color ? undefined : indicatorClassName}
					style={{
						transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease",
					}}
				/>
				{markers?.map((marker) => {
					const angle = (clampPercent(marker) / 100) * 2 * Math.PI - Math.PI / 2;
					const inner = Math.max(0, radius - stroke / 2 - 1);
					const outer = Math.min(size / 2, radius + stroke / 2 + 1);
					return (
						<line
							key={marker}
							data-testid="progress-ring-marker"
							x1={center + inner * Math.cos(angle)}
							y1={center + inner * Math.sin(angle)}
							x2={center + outer * Math.cos(angle)}
							y2={center + outer * Math.sin(angle)}
							stroke="currentColor"
							strokeWidth={Math.max(1.5, stroke / 2.5)}
							strokeLinecap="round"
							className={cn("text-foreground/70", markerClassName)}
						/>
					);
				})}
			</svg>
			{label !== undefined && label !== null && (
				<span
					className={cn(
						"absolute inset-0 flex items-center justify-center font-semibold tabular-nums",
						labelClassName,
					)}
					style={labelStyle}
				>
					{label}
				</span>
			)}
		</div>
	);
}
