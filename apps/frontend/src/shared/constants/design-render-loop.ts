/**
 * The render loop's options as the Import Design page offers them (#379).
 *
 * The bounds are the runner's (`runners/design_to_code_runner.py`, which
 * refuses anything outside them); the main process checks them again before
 * passing a value on, and the page only offers the choices below.
 */
export const RENDER_LOOP_BOUNDS = {
	maxIterations: { min: 1, max: 10, default: 5 },
	threshold: { min: 0.5, max: 0.999, default: 0.95 },
	maxTokens: { min: 10_000, max: 5_000_000, default: 400_000 },
	maxCostUsd: { min: 0.01, max: 100, default: 2 },
} as const;

export const RENDER_LOOP_CHOICES = {
	maxIterations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
	threshold: [0.8, 0.85, 0.9, 0.95, 0.98, 0.99],
	maxTokens: [100_000, 200_000, 400_000, 800_000, 1_600_000],
	maxCostUsd: [0.5, 1, 2, 5, 10],
} as const;

/** The three widths of the responsive pass (`design_to_code.passes.BREAKPOINTS`). */
export const RENDER_LOOP_BREAKPOINTS = ["mobile", "tablet", "desktop"] as const;
