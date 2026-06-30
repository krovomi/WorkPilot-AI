import { ArrowLeft, ArrowRight, Check, Compass, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { useGuidedTourStore } from "./guided-tour-store";
import { guideSelector } from "./anchors";
import { waitForElement } from "./waitForElement";

/** Padding around the spotlight cut-out, in px. */
const SPOTLIGHT_PADDING = 8;

interface TargetRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/**
 * The guided-tour engine. Mounted once at the app root. When a tour is active
 * it: navigates Settings to the step's section, waits for the target to mount,
 * scrolls + focuses it, paints a dimming overlay with a cut-out spotlight over
 * the target, and anchors an instruction bubble next to it. "Next" is gated by
 * the step's live `condition`.
 */
export function GuidedTourOverlay() {
	const { t } = useTranslation("guidedTour");
	const isActive = useGuidedTourStore((s) => s.isActive);
	const steps = useGuidedTourStore((s) => s.steps);
	const currentIndex = useGuidedTourStore((s) => s.currentIndex);
	const navigateSettings = useGuidedTourStore((s) => s.navigateSettings);
	const next = useGuidedTourStore((s) => s.next);
	const back = useGuidedTourStore((s) => s.back);
	const stop = useGuidedTourStore((s) => s.stop);

	const step = isActive ? steps[currentIndex] : undefined;

	const [rect, setRect] = useState<TargetRect | null>(null);
	const [resolving, setResolving] = useState(false);
	const [notFound, setNotFound] = useState(false);
	// Re-evaluated on a light interval so the gate reflects live typing.
	const [gateOpen, setGateOpen] = useState(true);

	const isLast = currentIndex >= steps.length - 1;

	// ── Resolve + position the target whenever the step changes ───────────────
	useEffect(() => {
		if (!step) return;
		const controller = new AbortController();
		let cancelled = false;
		setResolving(true);
		setNotFound(false);
		setRect(null);

		// Bring the right section on screen first.
		navigateSettings?.(step.section);

		(async () => {
			const el = await waitForElement(
				guideSelector(step.anchor),
				1500,
				controller.signal,
			);
			if (cancelled) return;
			setResolving(false);
			if (!el) {
				setNotFound(true);
				return;
			}
			el.scrollIntoView({ block: "center", behavior: "smooth" });
			// Focus once it has settled into view.
			window.setTimeout(() => {
				if (cancelled) return;
				const focusable =
					el.matches("input, select, textarea, button, [role=switch]")
						? el
						: el.querySelector<HTMLElement>(
								"input, select, textarea, button, [role=switch]",
							);
				focusable?.focus({ preventScroll: true });
			}, 250);
		})();

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [step, navigateSettings]);

	// ── Keep the spotlight rect in sync on scroll / resize ────────────────────
	useEffect(() => {
		if (!step || notFound) return;
		const update = () => {
			const el = document.querySelector<HTMLElement>(
				guideSelector(step.anchor),
			);
			if (!el) return;
			const r = el.getBoundingClientRect();
			setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
		};
		update();
		const id = window.setInterval(update, 200); // covers smooth-scroll settle
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			window.clearInterval(id);
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [step, notFound]);

	// ── Live "Next" gate ──────────────────────────────────────────────────────
	useEffect(() => {
		if (!step) return;
		if (!step.condition) {
			setGateOpen(true);
			return;
		}
		const evaluate = () => setGateOpen(Boolean(step.condition?.()));
		evaluate();
		const id = window.setInterval(evaluate, 300);
		return () => window.clearInterval(id);
	}, [step]);

	// Esc closes the tour.
	useEffect(() => {
		if (!isActive) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") stop();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isActive, stop]);

	const handleNext = useCallback(() => next(), [next]);

	if (!isActive || !step) return null;

	const canAdvance = step.optional || !step.condition || gateOpen;
	const pad = SPOTLIGHT_PADDING;

	// Spotlight cut-out: four dim rectangles around the target leave a hole that
	// stays clickable (the overlay panes capture clicks; the hole does not).
	const holes =
		rect && !notFound
			? {
					top: Math.max(0, rect.top - pad),
					left: Math.max(0, rect.left - pad),
					width: rect.width + pad * 2,
					height: rect.height + pad * 2,
				}
			: null;

	const overlay = (
		<div className="fixed inset-0 z-[70]" aria-live="polite">
			{/* Dimming panes around the spotlight (each captures pointer events). */}
			{holes ? (
				<>
					<div
						className="absolute left-0 right-0 top-0 bg-black/60"
						style={{ height: holes.top }}
					/>
					<div
						className="absolute left-0 bg-black/60"
						style={{
							top: holes.top,
							width: holes.left,
							height: holes.height,
						}}
					/>
					<div
						className="absolute right-0 bg-black/60"
						style={{
							top: holes.top,
							left: holes.left + holes.width,
							height: holes.height,
						}}
					/>
					<div
						className="absolute left-0 right-0 bg-black/60"
						style={{ top: holes.top + holes.height, bottom: 0 }}
					/>
					{/* Highlight ring around the target (non-interactive). */}
					<div
						className="absolute rounded-md ring-2 ring-primary ring-offset-2 ring-offset-background pointer-events-none transition-all"
						style={{
							top: holes.top,
							left: holes.left,
							width: holes.width,
							height: holes.height,
						}}
					/>
				</>
			) : (
				// While resolving / not found, dim the whole screen.
				<div className="absolute inset-0 bg-black/60" />
			)}

			{/* Instruction bubble: anchored under the target, or centered if unknown. */}
			<div
				className="absolute w-80 max-w-[90vw] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl z-[71]"
				style={bubblePosition(holes)}
			>
				<div className="flex items-start gap-2">
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<Compass className="h-4 w-4" />
					</div>
					<div className="min-w-0 flex-1">
						<h3 className="font-medium text-foreground">{t(step.titleKey)}</h3>
						<p className="mt-1 text-sm text-muted-foreground">
							{notFound ? t("fallback.openManually") : t(step.descKey)}
						</p>
					</div>
					<button
						type="button"
						onClick={stop}
						aria-label={t("actions.close")}
						className="shrink-0 text-muted-foreground hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{!canAdvance && !notFound && (
					<p className="mt-3 text-xs text-warning">{t("gate.hint")}</p>
				)}

				<div className="mt-4 flex items-center justify-between">
					<span className="text-xs text-muted-foreground">
						{t("progress", {
							current: currentIndex + 1,
							total: steps.length,
						})}
					</span>
					<div className="flex items-center gap-2">
						{currentIndex > 0 && (
							<Button variant="ghost" size="sm" onClick={back} className="gap-1">
								<ArrowLeft className="h-3.5 w-3.5" />
								{t("actions.back")}
							</Button>
						)}
						{step.optional && !isLast && (
							<Button variant="ghost" size="sm" onClick={handleNext}>
								{t("actions.skip")}
							</Button>
						)}
						<Button
							size="sm"
							onClick={handleNext}
							disabled={!canAdvance && !notFound}
							className="gap-1"
						>
							{isLast ? (
								<>
									<Check className="h-3.5 w-3.5" />
									{t("actions.finish")}
								</>
							) : (
								<>
									{t("actions.next")}
									<ArrowRight className="h-3.5 w-3.5" />
								</>
							)}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);

	return createPortal(overlay, document.body);
}

/** Position the bubble just below the spotlight, clamped to the viewport. */
function bubblePosition(
	holes: { top: number; left: number; width: number; height: number } | null,
): React.CSSProperties {
	if (!holes) {
		return {
			top: "50%",
			left: "50%",
			transform: "translate(-50%, -50%)",
		};
	}
	const below = holes.top + holes.height + 12;
	const spaceBelow = window.innerHeight - below;
	const bubbleHeight = 200; // rough estimate for flip decision
	const top =
		spaceBelow < bubbleHeight ? Math.max(12, holes.top - bubbleHeight - 12) : below;
	// Keep left within [12, viewport - bubbleWidth - 12].
	const bubbleWidth = 320;
	const left = Math.min(
		Math.max(12, holes.left),
		Math.max(12, window.innerWidth - bubbleWidth - 12),
	);
	return { top, left };
}
