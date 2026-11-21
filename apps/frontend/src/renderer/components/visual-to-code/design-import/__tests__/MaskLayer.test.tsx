/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
		i18n: { language: "en" },
	}),
}));

import { RENDER_LOOP_MAX_MASKS } from "../../../../../shared/constants/design-render-loop";
import { useDesignToCodeStore } from "../../../../stores/design-to-code-store";
import { boxBetween, MaskLayer } from "../MaskLayer";

const masks = () => useDesignToCodeStore.getState().loopOptions.masks;

/** A pointer gesture on the surface, in pixels of a 200×100 design. */
function drag(from: [number, number], to: [number, number]) {
	const surface = screen.getByTestId("design-mask-surface");
	fireEvent.pointerDown(surface, { clientX: from[0], clientY: from[1], pointerId: 1 });
	fireEvent.pointerMove(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
	fireEvent.pointerUp(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

beforeEach(() => {
	useDesignToCodeStore.setState({ ...useDesignToCodeStore.getInitialState(), notes: {} });
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		width: 200,
		height: 100,
	} as DOMRect);
});

afterEach(() => vi.restoreAllMocks());

describe("boxBetween", () => {
	it("is the rectangle between two points, whichever way it was drawn", () => {
		expect(boxBetween({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.1 })).toEqual({ x: 0.25, y: 0.1, w: 0.5, h: 0.4 });
		expect(boxBetween({ x: 0.123456, y: 0 }, { x: 0.5, y: 1 })).toEqual({ x: 0.1235, y: 0, w: 0.3765, h: 1 });
	});
});

describe("MaskLayer", () => {
	it("draws a zone only once drawing is on, and removes it on its button", () => {
		render(<MaskLayer disabled={false} />);
		drag([20, 10], [120, 60]);
		expect(masks()).toEqual([]);

		const draw = screen.getByTestId("design-mask-draw");
		fireEvent.click(draw);
		expect(draw).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("design-mask-surface")).toHaveAttribute("data-drawing", "true");
		drag([20, 10], [120, 60]);
		expect(masks()).toEqual([{ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }]);
		// The same zone again is the same zone.
		drag([120, 60], [20, 10]);
		expect(masks()).toHaveLength(1);
		// Outside the picture is its edge.
		drag([150, 50], [400, 300]);
		expect(masks()[1]).toEqual({ x: 0.75, y: 0.5, w: 0.25, h: 0.5 });
		expect(screen.getAllByTestId("design-mask")).toHaveLength(2);
		expect(screen.getByTestId("design-mask-count")).toHaveTextContent(
			`masks.count {"count":2,"max":${RENDER_LOOP_MAX_MASKS}}`,
		);

		// Pressing a zone's button does not start a new zone.
		const removeFirst = screen.getByRole("button", { name: 'masks.remove {"index":1}' });
		fireEvent.pointerDown(removeFirst, { clientX: 30, clientY: 20 });
		expect(document.querySelector('[data-draft="true"]')).toBeNull();
		fireEvent.click(removeFirst);
		expect(masks()).toEqual([{ x: 0.75, y: 0.5, w: 0.25, h: 0.5 }]);
		fireEvent.click(screen.getByTestId("design-mask-clear"));
		expect(masks()).toEqual([]);
	});

	it("ignores a stray click and a move with no gesture started", () => {
		render(<MaskLayer disabled={false} />);
		fireEvent.click(screen.getByTestId("design-mask-draw"));
		const surface = screen.getByTestId("design-mask-surface");
		fireEvent.pointerMove(surface, { clientX: 50, clientY: 50 });
		fireEvent.pointerUp(surface, { clientX: 50, clientY: 50 });
		drag([50, 50], [51, 80]);
		expect(masks()).toEqual([]);
	});

	it("shows the zone being drawn before it is let go", () => {
		render(<MaskLayer disabled={false} />);
		fireEvent.click(screen.getByTestId("design-mask-draw"));
		const surface = screen.getByTestId("design-mask-surface");
		fireEvent.pointerDown(surface, { clientX: 0, clientY: 0 });
		fireEvent.pointerMove(surface, { clientX: 100, clientY: 50 });
		expect(surface.querySelector('[data-draft="true"]')).toHaveStyle({ width: "50%", height: "50%" });
	});

	it("reads a picture with no size as its corner", () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			width: 0,
			height: 0,
		} as DOMRect);
		render(<MaskLayer disabled={false} />);
		fireEvent.click(screen.getByTestId("design-mask-draw"));
		drag([10, 10], [90, 90]);
		expect(masks()).toEqual([]);
	});

	it("stops at the runner's number of zones, and while a run goes on", () => {
		const full = Array.from({ length: RENDER_LOOP_MAX_MASKS }, (_, i) => ({ x: i / 20, y: 0, w: 0.05, h: 0.1 }));
		useDesignToCodeStore.getState().setLoopOptions({ masks: full });
		const { rerender } = render(<MaskLayer disabled={false} />);
		expect(screen.getByTestId("design-mask-draw")).toBeDisabled();
		useDesignToCodeStore.getState().setLoopOptions({ masks: full.slice(0, 1) });
		rerender(<MaskLayer disabled />);
		expect(screen.getByTestId("design-mask-draw")).toBeDisabled();
		expect(screen.getByTestId("design-mask-clear")).toBeDisabled();
		expect(screen.getByRole("button", { name: 'masks.remove {"index":1}' })).toBeDisabled();
	});

	it("is cleared when the design changes", () => {
		const store = useDesignToCodeStore.getState();
		store.setLoopOptions({ masks: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] });
		store.setImageData("data:a", "data:a", "a.png");
		expect(masks()).toEqual([]);
		store.setLoopOptions({ masks: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] });
		store.clearImage();
		expect(masks()).toEqual([]);
	});
});
