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

	// ── Navigate + resolve + scroll/focus, exactly once per step ──────────────
	// Keyed on currentIndex (a primitive) so it does NOT re-run on every render —
	// re-running would re-fire navigateSettings() and cause a render loop.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on step index intentionally
	useEffect(() => {
		if (!isActive) return;
		const current = steps[currentIndex];
		if (!current) return;
		const controller = new AbortController();
		let cancelled = false;
		setResolving(true);
		setNotFound(false);
		setRect(null);

		// Bring the right section on screen first.
		console.info(
			`[guided-tour] step ${currentIndex + 1}/${steps.length}: navigate`,
			current.section,
			"→ anchor",
			current.anchor,
		);
		navigateSettings?.(current.section);

		(async () => {
			const selector = guideSelector(current.anchor);
			// First attempt.
			let el = await waitForElement(selector, 1200, controller.signal);
			// Retry navigation once if the section/field hasn't mounted yet —
			// switching sections in the already-open dialog can lose the first
			// navigate if its listener wasn't mounted at dispatch time.
			if (!el && !cancelled) {
				console.info(
					`[guided-tour] retry navigate for anchor: ${current.anchor}`,
				);
				navigateSettings?.(current.section);
				el = await waitForElement(selector, 1800, controller.signal);
			}
			if (cancelled) return;
			setResolving(false);
			if (!el) {
				console.warn(
					`[guided-tour] anchor NOT found: ${current.anchor} — activeSection?`,
					document.querySelector("[data-guide]")?.getAttribute("data-guide") ??
						"(no data-guide in DOM)",
				);
				setNotFound(true);
				return;
			}
			console.info(`[guided-tour] anchor resolved: ${current.anchor}`);
			el.scrollIntoView({ block: "center", behavior: "smooth" });
			window.setTimeout(() => {
				if (cancelled) return;
				const focusable = el.matches(
					"input, select, textarea, button, [role=switch]",
				)
					? el
					: el.querySelector<HTMLElement>(
							"input, select, textarea, button, [role=switch]",
						);
				focusable?.focus({ preventScroll: true });
			}, 300);
		})();

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [isActive, currentIndex]);

	// ── Keep the spotlight rect in sync via rAF; only update on real change ────
	// Runs continuously (even after a transient miss) so the spotlight re-locks
	// when the section re-renders — settings sections flicker null while their
	// env config (re)loads, briefly removing then re-adding the anchor.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on step index intentionally
	useEffect(() => {
		if (!isActive) return;
		const current = steps[currentIndex];
		if (!current) return;
		let rafId = 0;
		const sel = guideSelector(current.anchor);
		const loop = () => {
			const el = document.querySelector<HTMLElement>(sel);
			if (el) {
				// Anchor present → ensure we're not stuck in the not-found state.
				setNotFound((nf) => (nf ? false : nf));
				const r = el.getBoundingClientRect();
				// Only set state when the rect meaningfully changed — otherwise we
				// re-render the whole app on every frame.
				setRect((prev) =>
					prev &&
					Math.abs(prev.top - r.top) < 0.5 &&
					Math.abs(prev.left - r.left) < 0.5 &&
					Math.abs(prev.width - r.width) < 0.5 &&
					Math.abs(prev.height - r.height) < 0.5
						? prev
						: { top: r.top, left: r.left, width: r.width, height: r.height },
				);
			}
			rafId = requestAnimationFrame(loop);
		};
		rafId = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(rafId);
	}, [isActive, currentIndex]);

	// ── Live "Next" gate ──────────────────────────────────────────────────────
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on step index intentionally
	useEffect(() => {
		if (!isActive) return;
		const current = steps[currentIndex];
		if (!current) return;
		if (!current.condition) {
			setGateOpen(true);
			return;
		}
		const cond = current.condition;
		const evaluate = () => setGateOpen((prev) => {
			const v = Boolean(cond());
			return prev === v ? prev : v;
		});
		evaluate();
		const id = window.setInterval(evaluate, 400);
		return () => window.clearInterval(id);
	}, [isActive, currentIndex]);

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
		// Root is non-interactive so the spotlight hole lets clicks reach the
		// target. Only the dim panes and the bubble re-enable pointer events.
		<div className="fixed inset-0 z-200 pointer-events-none" aria-live="polite">
			{/* Dimming panes around the spotlight (each captures pointer events,
			    blocking interaction everywhere EXCEPT the hole over the target). */}
			{holes ? (
				<>
					<div
						className="absolute left-0 right-0 top-0 bg-black/60 pointer-events-auto"
						style={{ height: holes.top }}
					/>
					<div
						className="absolute left-0 bg-black/60 pointer-events-auto"
						style={{
							top: holes.top,
							width: holes.left,
							height: holes.height,
						}}
					/>
					<div
						className="absolute right-0 bg-black/60 pointer-events-auto"
						style={{
							top: holes.top,
							left: holes.left + holes.width,
							height: holes.height,
						}}
					/>
					<div
						className="absolute left-0 right-0 bg-black/60 pointer-events-auto"
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
				<div className="absolute inset-0 bg-black/60 pointer-events-auto" />
			)}

			{/* Instruction bubble: anchored under the target, or centered if unknown. */}
			<div
				className="absolute w-80 max-w-[90vw] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl z-10 pointer-events-auto"
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
						<p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
							{step.anchor}
							{resolving ? " · …" : notFound ? " · introuvable" : " · ok"}
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
