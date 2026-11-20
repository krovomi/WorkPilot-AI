/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key} ${JSON.stringify(options)}` : key,
	}),
}));

import type { SetupDeepLink } from "../../setup-hub/useSetupStatus";
import { GuidedTourOverlay } from "../GuidedTourOverlay";
import { type GuidedStep, useGuidedTourStore } from "../guided-tour-store";

const github: SetupDeepLink = { kind: "project", section: "github" };
const jira: SetupDeepLink = { kind: "project", section: "jira" };
const accounts: SetupDeepLink = { kind: "app", section: "accounts" };

const step = (anchor: string, section: SetupDeepLink, extra: Partial<GuidedStep> = {}): GuidedStep => ({
	anchor,
	section,
	titleKey: `title.${anchor}`,
	descKey: `desc.${anchor}`,
	...extra,
});

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** A target in the page, at a given place on the screen. */
function target(anchor: string, box: Box, wrapper = false) {
	const el = document.createElement(wrapper ? "div" : "input");
	el.setAttribute("data-guide", anchor);
	if (wrapper) {
		const label = document.createElement("span");
		const field = document.createElement("input");
		field.setAttribute("aria-label", "token");
		el.append(label, field);
	}
	el.getBoundingClientRect = () =>
		({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top }) as DOMRect;
	document.body.appendChild(el);
	targets.push(el);
	return el;
}

const targets: HTMLElement[] = [];
const navigate = vi.fn();
const scrollIntoView = vi.fn();
const store = () => useGuidedTourStore.getState();

function start(steps: GuidedStep[], index = 0) {
	act(() => {
		store().registerNavigate(navigate);
		store().startTour(steps);
		useGuidedTourStore.setState({ currentIndex: index });
	});
}

/** Lets the timers and the promises between them run. */
const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const panes = () => document.querySelectorAll<HTMLElement>(".bg-black\\/60");
const bubble = () => document.querySelector<HTMLElement>(".w-80") as HTMLElement;

beforeEach(() => {
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"requestAnimationFrame",
			"cancelAnimationFrame",
			"performance",
		],
	});
	vi.resetAllMocks();
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
	Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
	Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
	useGuidedTourStore.setState({ ...useGuidedTourStore.getInitialState() });
});

afterEach(() => {
	for (const el of targets.splice(0)) el.remove();
	vi.useRealTimers();
});

describe("GuidedTourOverlay", () => {
	it("draws nothing without a tour", () => {
		const { container } = render(<GuidedTourOverlay />);
		expect(container).toBeEmptyDOMElement();
		expect(document.querySelector(".w-80")).not.toBeInTheDocument();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(navigate).not.toHaveBeenCalled();
	});

	it("opens the step's section, lights its target and focuses it", async () => {
		const input = target("github.enable", { top: 100, left: 200, width: 120, height: 30 });
		start([step("github.enable", github), step("jira.enable", jira)]);
		render(<GuidedTourOverlay />);
		expect(navigate).toHaveBeenCalledWith(github);
		// Before the first frame the whole screen is dimmed and the bubble centered.
		expect(panes()).toHaveLength(1);
		expect(bubble().style.transform).toBe("translate(-50%, -50%)");

		await elapse(20);
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
		// Four panes around a hole of the target plus the padding, and the ring.
		expect(panes()).toHaveLength(4);
		const ring = document.querySelector<HTMLElement>(".ring-2") as HTMLElement;
		expect(ring.style.top).toBe("92px");
		expect(ring.style.left).toBe("192px");
		expect(ring.style.width).toBe("136px");
		expect(ring.style.height).toBe("46px");
		expect(bubble().style.top).toBe("150px");
		expect(bubble().style.left).toBe("192px");
		expect(screen.getByText("title.github.enable")).toBeInTheDocument();
		expect(screen.getByText("desc.github.enable")).toBeInTheDocument();
		expect(screen.getByText('progress {"current":1,"total":2}')).toBeInTheDocument();

		expect(input).not.toHaveFocus();
		await elapse(300);
		expect(input).toHaveFocus();
	});

	it("focuses the field inside a target that is not one itself", async () => {
		target("jira.token", { top: 10, left: 0, width: 50, height: 20 }, true);
		start([step("jira.token", jira)]);
		render(<GuidedTourOverlay />);
		await elapse(400);
		expect(screen.getByLabelText("token")).toHaveFocus();
		// Close to the top-left corner, the hole and the bubble stay on screen.
		const ring = document.querySelector<HTMLElement>(".ring-2") as HTMLElement;
		expect(ring.style.top).toBe("2px");
		expect(ring.style.left).toBe("0px");
		expect(bubble().style.left).toBe("12px");
	});

	it("moves the bubble above a target near the bottom, and keeps it inside the width", async () => {
		target("jira.enable", { top: 700, left: 1100, width: 80, height: 20 });
		start([step("jira.enable", jira)]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		expect(bubble().style.top).toBe("480px");
		expect(bubble().style.left).toBe("868px");
	});

	it("follows a target that moves, and ignores sub-pixel jitter", async () => {
		const el = target("jira.enable", { top: 100, left: 100, width: 50, height: 20 });
		start([step("jira.enable", jira)]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		const ring = () => document.querySelector<HTMLElement>(".ring-2") as HTMLElement;
		expect(ring().style.top).toBe("92px");

		el.getBoundingClientRect = () => ({ top: 100.2, left: 100.2, width: 50.2, height: 20.2 }) as DOMRect;
		await elapse(20);
		expect(ring().style.top).toBe("92px");

		for (const box of [
			{ top: 300, left: 100, width: 50, height: 20 },
			{ top: 300, left: 400, width: 50, height: 20 },
			{ top: 300, left: 400, width: 90, height: 20 },
			{ top: 300, left: 400, width: 90, height: 60 },
		]) {
			el.getBoundingClientRect = () => box as DOMRect;
			await elapse(20);
			expect(ring().style.top).toBe(`${box.top - 8}px`);
			expect(ring().style.left).toBe(`${box.left - 8}px`);
			expect(ring().style.width).toBe(`${box.width + 16}px`);
			expect(ring().style.height).toBe(`${box.height + 16}px`);
		}
	});

	it("holds Next until the step's field is filled", async () => {
		let filled = false;
		target("github.token", { top: 100, left: 100, width: 50, height: 20 });
		start([step("github.token", github, { condition: () => filled }), step("jira.enable", jira)]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		const nextButton = screen.getByRole("button", { name: /actions\.next/ });
		expect(nextButton).toBeDisabled();
		expect(screen.getByText("gate.hint")).toBeInTheDocument();

		filled = true;
		await elapse(400);
		expect(nextButton).toBeEnabled();
		expect(screen.queryByText("gate.hint")).not.toBeInTheDocument();
		await elapse(400);
		expect(nextButton).toBeEnabled();

		fireEvent.click(nextButton);
		expect(store().currentIndex).toBe(1);
	});

	it("lets an optional step be skipped, goes back, and finishes on the last one", async () => {
		target("github.enable", { top: 0, left: 0, width: 10, height: 10 });
		target("github.repo", { top: 0, left: 0, width: 10, height: 10 });
		target("jira.enable", { top: 0, left: 0, width: 10, height: 10 });
		start([
			step("github.enable", github),
			step("github.repo", github, { optional: true, condition: () => false }),
			step("jira.enable", jira),
		]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		expect(screen.queryByRole("button", { name: /actions\.back/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "actions.skip" })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /actions\.next/ }));
		await elapse(20);
		// An optional step is never held, even with a condition that fails.
		expect(screen.getByRole("button", { name: /actions\.next/ })).toBeEnabled();
		expect(screen.queryByText("gate.hint")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /actions\.back/ }));
		expect(store().currentIndex).toBe(0);
		await elapse(20);

		fireEvent.click(screen.getByRole("button", { name: /actions\.next/ }));
		fireEvent.click(screen.getByRole("button", { name: "actions.skip" }));
		expect(store().currentIndex).toBe(2);
		await elapse(20);
		expect(screen.queryByRole("button", { name: "actions.skipSection" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /actions\.finish/ }));
		expect(store().isActive).toBe(false);
		expect(document.querySelector(".w-80")).not.toBeInTheDocument();
	});

	it("offers no skip on an optional last step", async () => {
		target("github.repo", { top: 0, left: 0, width: 10, height: 10 });
		start([step("github.repo", github, { optional: true })]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		expect(screen.queryByRole("button", { name: "actions.skip" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /actions\.finish/ })).toBeInTheDocument();
	});

	it("skips the rest of a section, and closes on the cross or Escape", async () => {
		target("github.enable", { top: 0, left: 0, width: 10, height: 10 });
		target("jira.enable", { top: 0, left: 0, width: 10, height: 10 });
		start([step("github.enable", github), step("github.token", github), step("jira.enable", jira)]);
		const { unmount } = render(<GuidedTourOverlay />);
		await elapse(20);
		fireEvent.click(screen.getByRole("button", { name: "actions.skipSection" }));
		expect(store().currentIndex).toBe(2);
		await elapse(20);
		fireEvent.click(screen.getByRole("button", { name: "actions.close" }));
		expect(store().isActive).toBe(false);
		unmount();

		start([step("github.enable", github), step("providers.configure", accounts)]);
		render(<GuidedTourOverlay />);
		fireEvent.keyDown(window, { key: "Enter" });
		expect(store().isActive).toBe(true);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(store().isActive).toBe(false);
	});

	it("tells a section apart by its kind as well as its name", async () => {
		const app: SetupDeepLink = { kind: "app", section: "github" as never };
		target("github.enable", { top: 0, left: 0, width: 10, height: 10 });
		start([step("github.enable", github), step("github.token", app)]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		expect(screen.getByRole("button", { name: "actions.skipSection" })).toBeInTheDocument();
	});

	it("passes over a target that never shows, in the direction of travel", async () => {
		target("github.enable", { top: 0, left: 0, width: 10, height: 10 });
		target("jira.enable", { top: 0, left: 0, width: 10, height: 10 });
		start([step("github.enable", github), step("github.token", github), step("jira.enable", jira)]);
		render(<GuidedTourOverlay />);
		await elapse(20);

		fireEvent.click(screen.getByRole("button", { name: /actions\.next/ }));
		expect(store().currentIndex).toBe(1);
		navigate.mockClear();
		await elapse(3100);
		// The section is opened again every second miss while waiting.
		expect(navigate.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(store().currentIndex).toBe(2);

		await elapse(20);
		fireEvent.click(screen.getByRole("button", { name: /actions\.back/ }));
		expect(store().currentIndex).toBe(1);
		await elapse(3100);
		expect(store().currentIndex).toBe(0);
	});

	it("asks to open the section by hand when the first or last target never shows", async () => {
		target("jira.token", { top: 0, left: 0, width: 10, height: 10 });
		start([step("github.token", github, { condition: () => false }), step("jira.token", jira)], 1);
		const { unmount } = render(<GuidedTourOverlay />);
		await elapse(20);
		// Going back onto the first step: nothing earlier to fall back on.
		fireEvent.click(screen.getByRole("button", { name: /actions\.back/ }));
		await elapse(3100);
		expect(store().currentIndex).toBe(0);
		expect(screen.getByText("fallback.openManually")).toBeInTheDocument();
		expect(screen.queryByText("gate.hint")).not.toBeInTheDocument();
		// Next stays usable so the person is never stuck on a step that cannot be shown.
		expect(screen.getByRole("button", { name: /actions\.next/ })).toBeEnabled();
		expect(panes()).toHaveLength(1);

		// The target shows up after all: the spotlight locks on it.
		target("github.token", { top: 50, left: 50, width: 10, height: 10 });
		await elapse(20);
		expect(screen.queryByText("fallback.openManually")).not.toBeInTheDocument();
		expect(panes()).toHaveLength(4);
		unmount();

		start([step("linear.apiKey", { kind: "project", section: "linear" })]);
		render(<GuidedTourOverlay />);
		await elapse(3100);
		expect(store().isActive).toBe(true);
		expect(screen.getByText("fallback.openManually")).toBeInTheDocument();
	});

	it("stops waiting and focusing once the tour is closed", async () => {
		start([step("github.token", github)]);
		const { unmount } = render(<GuidedTourOverlay />);
		await elapse(700);
		act(() => store().stop());
		await elapse(3100);
		expect(navigate).toHaveBeenCalledTimes(1);
		unmount();

		const input = target("jira.enable", { top: 0, left: 0, width: 10, height: 10 });
		start([step("jira.enable", jira)]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		act(() => store().stop());
		await elapse(400);
		expect(input).not.toHaveFocus();
	});

	it("does not fail when the target leaves before it is focused", async () => {
		const input = target("jira.enable", { top: 0, left: 0, width: 10, height: 10 });
		start([step("jira.enable", jira)]);
		render(<GuidedTourOverlay />);
		await elapse(20);
		input.remove();
		await elapse(400);
		expect(input).not.toHaveFocus();
		expect(screen.getByText("title.jira.enable")).toBeInTheDocument();
	});

	it("works without a registered settings navigator", async () => {
		const input = target("jira.enable", { top: 0, left: 0, width: 10, height: 10 });
		act(() => store().startTour([step("jira.enable", jira), step("jira.token", jira)]));
		render(<GuidedTourOverlay />);
		await elapse(400);
		expect(input).toHaveFocus();
		input.remove();
		act(() => store().next());
		await elapse(3100);
		expect(screen.getByText("fallback.openManually")).toBeInTheDocument();
	});
});
