import { EyeOff, X } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RENDER_LOOP_MAX_MASKS } from "../../../../shared/constants/design-render-loop";
import type { DesignBounds } from "../../../../shared/types/design-to-code";
import { useDesignToCodeStore } from "../../../stores/design-to-code-store";

/** A zone smaller than this share of the design, on either side, is a stray click. */
const MIN_SIDE = 0.01;

type Point = { x: number; y: number };

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** The rectangle between two points, as fractions of the design. */
export function boxBetween(a: Point, b: Point): DesignBounds {
	const x = round(Math.min(a.x, b.x));
	const y = round(Math.min(a.y, b.y));
	return {
		x,
		y,
		w: round(Math.min(Math.max(a.x, b.x), 1) - x),
		h: round(Math.min(Math.max(a.y, b.y), 1) - y),
	};
}

const keyOf = (box: DesignBounds) => `${box.x},${box.y},${box.w},${box.h}`;

const place = (box: DesignBounds) => ({
	left: `${box.x * 100}%`,
	top: `${box.y * 100}%`,
	width: `${box.w * 100}%`,
	height: `${box.h * 100}%`,
});

/**
 * Zones the person draws on the design, left out of the render loop's score
 * (#379): a date, a photo, live data the vision step did not see as dynamic.
 * Drawn with the pointer once "Hide a zone" is on; each one is removed with
 * its own button. The main process and the runner check every zone again.
 */
export function MaskLayer({ disabled }: { disabled: boolean }) {
	const { t } = useTranslation("designToCode");
	const masks = useDesignToCodeStore((s) => s.loopOptions.masks);
	const setLoopOptions = useDesignToCodeStore((s) => s.setLoopOptions);
	const [drawing, setDrawing] = useState(false);
	const [start, setStart] = useState<Point | null>(null);
	const [end, setEnd] = useState<Point | null>(null);
	const surface = useRef<HTMLDivElement>(null);
	const full = masks.length >= RENDER_LOOP_MAX_MASKS;
	const active = drawing && !disabled && !full;

	const point = (event: PointerEvent<HTMLDivElement>): Point => {
		const rect = surface.current?.getBoundingClientRect();
		if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
		return {
			x: clamp((event.clientX - rect.left) / rect.width),
			y: clamp((event.clientY - rect.top) / rect.height),
		};
	};

	const onDown = (event: PointerEvent<HTMLDivElement>) => {
		if (!active) return;
		event.currentTarget.setPointerCapture?.(event.pointerId);
		const at = point(event);
		setStart(at);
		setEnd(at);
	};
	const onMove = (event: PointerEvent<HTMLDivElement>) => {
		if (start) setEnd(point(event));
	};
	const onUp = (event: PointerEvent<HTMLDivElement>) => {
		if (!start) return;
		const box = boxBetween(start, point(event));
		setStart(null);
		setEnd(null);
		const known = masks.some((mask) => keyOf(mask) === keyOf(box));
		if (box.w >= MIN_SIDE && box.h >= MIN_SIDE && !known) {
			setLoopOptions({ masks: [...masks, box] });
		}
	};
	const remove = (index: number) =>
		setLoopOptions({ masks: masks.filter((_, i) => i !== index) });

	return (
		<>
			<div
				ref={surface}
				className="di-mask-surface"
				data-drawing={active}
				data-testid="design-mask-surface"
				onPointerDown={onDown}
				onPointerMove={onMove}
				onPointerUp={onUp}
			>
				{masks.map((box, index) => (
					<div
						// A zone is its place: the same one is never added twice.
						key={keyOf(box)}
						className="di-mask"
						style={place(box)}
						data-testid="design-mask"
					>
						<button
							type="button"
							disabled={disabled}
							onPointerDown={(event) => event.stopPropagation()}
							onClick={() => remove(index)}
							aria-label={t("masks.remove", { index: index + 1 })}
							title={t("masks.remove", { index: index + 1 })}
						>
							<X className="h-3 w-3" />
						</button>
					</div>
				))}
				{start && end && <div className="di-mask" data-draft="true" style={place(boxBetween(start, end))} />}
			</div>
			<div className="di-mask-bar">
				<button
					type="button"
					className="di-pick"
					data-open={active}
					aria-pressed={active}
					disabled={disabled || full}
					onClick={() => setDrawing((on) => !on)}
					data-testid="design-mask-draw"
					title={t("masks.hint")}
				>
					<EyeOff className="h-3 w-3" />
					{t(active ? "masks.drawing" : "masks.draw")}
				</button>
				{masks.length > 0 && (
					<>
						<span className="di-faint text-2xs" data-testid="design-mask-count">
							{t("masks.count", { count: masks.length, max: RENDER_LOOP_MAX_MASKS })}
						</span>
						<button
							type="button"
							className="di-pick"
							disabled={disabled}
							onClick={() => setLoopOptions({ masks: [] })}
							data-testid="design-mask-clear"
						>
							{t("masks.clear")}
						</button>
					</>
				)}
			</div>
		</>
	);
}
