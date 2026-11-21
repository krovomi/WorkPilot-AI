import { RENDER_LOOP_BOUNDS } from "../shared/constants/design-render-loop";

type Bound = { min: number; max: number };

/** ``value`` when it is a finite number within ``bound`` (an integer if asked). */
function within(value: unknown, bound: Bound, integer: boolean): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (integer && !Number.isInteger(value)) return undefined;
	return value >= bound.min && value <= bound.max ? value : undefined;
}

/**
 * The runner's flags for the render loop's options, from what the renderer
 * sent (untrusted): a value of the wrong type or out of its bounds is left
 * out, and the runner falls back to its default. The runner checks the bounds
 * again (argparse), so this is never the only check.
 */
export function renderLoopArgs(options: unknown): string[] {
	if (!options || typeof options !== "object") return [];
	const o = options as Record<string, unknown>;
	const args: string[] = [];
	const flags: [keyof typeof RENDER_LOOP_BOUNDS, string, boolean][] = [
		["maxIterations", "--loop-max-iterations", true],
		["threshold", "--loop-threshold", false],
		["maxTokens", "--loop-max-tokens", true],
		["maxCostUsd", "--loop-max-cost", false],
	];
	for (const [key, flag, integer] of flags) {
		const value = within(o[key], RENDER_LOOP_BOUNDS[key], integer);
		if (value !== undefined) args.push(flag, String(value));
	}
	if (o.responsive === true) args.push("--loop-responsive");
	if (o.states === true) args.push("--loop-states");
	return args;
}
