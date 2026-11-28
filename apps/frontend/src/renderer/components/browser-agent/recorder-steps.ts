import type { RecordedStep } from "@shared/types/browser-recorder";

/** How the step finds its element, as a short line: the first, most robust selector (and its place, `#n`). */
export function selectorSummary(step: RecordedStep): string {
	const selector = step.selectors[0];
	if (!selector) return step.url ?? "";
	const found =
		selector.strategy === "role"
			? `${selector.role} "${selector.value}"`
			: `${selector.strategy} "${selector.value}"`;
	return selector.nth === undefined ? found : `${found} #${selector.nth + 1}`;
}

/** What the step types, picks or scrolls to, as page text (never markup). */
export function stepDetail(step: RecordedStep): string {
	if (step.kind === "navigate") return "";
	if (step.kind === "scroll") return `${step.scrollX ?? 0}, ${step.scrollY ?? 0}`;
	if (step.values?.length) return step.values.join(", ");
	return step.value ?? step.text ?? "";
}
