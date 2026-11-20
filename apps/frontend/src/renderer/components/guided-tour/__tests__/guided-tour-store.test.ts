import { beforeEach, describe, expect, it } from "vitest";
import type { SetupDeepLink } from "../../setup-hub/useSetupStatus";
import { type GuidedStep, startGuidedTour, useGuidedTourStore } from "../guided-tour-store";

const proj = (section: SetupDeepLink["section"]): SetupDeepLink => ({
	kind: "project",
	section: section as never,
});

const step = (anchor: string, section: SetupDeepLink): GuidedStep => ({
	anchor,
	section,
	titleKey: "t",
	descKey: "d",
});

// A tour with two GitHub steps then two Jira steps then one Linear step.
const TOUR: GuidedStep[] = [
	step("github.enable", proj("github")),
	step("github.token", proj("github")),
	step("jira.enable", proj("jira")),
	step("jira.token", proj("jira")),
	step("linear.enable", proj("linear")),
];

describe("guided-tour store: skipSection", () => {
	beforeEach(() => {
		useGuidedTourStore.getState().stop();
	});

	it("jumps from a section's first step to the next section's first step", () => {
		const s = useGuidedTourStore.getState();
		s.startTour(TOUR);
		expect(useGuidedTourStore.getState().currentIndex).toBe(0); // github.enable
		s.skipSection();
		// Should land on jira.enable (index 2), skipping github.token.
		expect(useGuidedTourStore.getState().currentIndex).toBe(2);
		expect(useGuidedTourStore.getState().steps[2].anchor).toBe("jira.enable");
	});

	it("skips from the middle of a section too", () => {
		const s = useGuidedTourStore.getState();
		s.startTour(TOUR);
		s.next(); // github.token (index 1)
		expect(useGuidedTourStore.getState().currentIndex).toBe(1);
		s.skipSection();
		expect(useGuidedTourStore.getState().currentIndex).toBe(2); // jira.enable
	});

	it("ends the tour when skipping the last section", () => {
		const s = useGuidedTourStore.getState();
		s.startTour(TOUR);
		s.skipSection(); // -> jira (2)
		s.skipSection(); // -> linear (4)
		expect(useGuidedTourStore.getState().currentIndex).toBe(4);
		s.skipSection(); // linear is last section -> end
		expect(useGuidedTourStore.getState().isActive).toBe(false);
		expect(useGuidedTourStore.getState().steps).toHaveLength(0);
	});
});

describe("guided-tour store: navigation", () => {
	beforeEach(() => {
		useGuidedTourStore.getState().stop();
	});

	it("does not start a tour without steps", () => {
		useGuidedTourStore.getState().startTour([]);
		expect(useGuidedTourStore.getState().isActive).toBe(false);
	});

	it("goes back but never before the first step", () => {
		const s = useGuidedTourStore.getState();
		s.startTour(TOUR);
		s.back();
		expect(useGuidedTourStore.getState().currentIndex).toBe(0);
		s.next();
		s.next();
		s.back();
		expect(useGuidedTourStore.getState().currentIndex).toBe(1);
	});

	it("has nothing to skip when no tour runs", () => {
		useGuidedTourStore.getState().skipSection();
		expect(useGuidedTourStore.getState()).toMatchObject({ isActive: false, currentIndex: 0 });
	});

	it("starts a tour from outside React and keeps the settings navigator", () => {
		const navigate = () => undefined;
		useGuidedTourStore.getState().registerNavigate(navigate);
		startGuidedTour(TOUR);
		expect(useGuidedTourStore.getState()).toMatchObject({ isActive: true, currentIndex: 0, navigateSettings: navigate });
	});
});
