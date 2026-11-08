/**
 * The phase steps (Analyser — Découvrir — Générer) carried a stray ")" text
 * node after each step: a leftover of a JSX edit, rendered as "Analyser ) —".
 *
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { TooltipProvider } from "../ui/tooltip";
import { RoadmapGenerationProgress } from "../RoadmapGenerationProgress";

describe("RoadmapGenerationProgress phase steps", () => {
	beforeAll(() => {
		globalThis.matchMedia ??= ((query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		})) as unknown as typeof globalThis.matchMedia;
	});

	it.each(["analyzing", "error"] as const)(
		"renders the steps without stray characters (%s)",
		(phase) => {
			render(
				<TooltipProvider>
					<RoadmapGenerationProgress
						generationStatus={{ phase, progress: 0, message: "", error: "boom" }}
					/>
				</TooltipProvider>,
			);
			const step = screen.getByText("roadmapProgress.steps.analyze");
			const row = step.parentElement?.parentElement;
			expect(row?.textContent).toBe(
				"roadmapProgress.steps.analyzeroadmapProgress.steps.discoverroadmapProgress.steps.generate",
			);
		},
	);
});
