/**
 * The error boundary keeps a caught error until "Try again" or a new reset
 * key (the page on screen), and says what it was given to say.
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../../lib/sentry", () => ({ captureException: vi.fn() }));

import { ErrorBoundary } from "../error-boundary";

const state = { broken: true };

function Child() {
	if (state.broken) throw new Error("render failed");
	return <p data-testid="child">ok</p>;
}

describe("ErrorBoundary", () => {
	beforeEach(() => {
		state.broken = true;
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("shows the default description and the error, and retries on demand", () => {
		const onReset = vi.fn();
		render(
			<ErrorBoundary onReset={onReset}>
				<Child />
			</ErrorBoundary>,
		);
		const card = screen.getByRole("alert");
		expect(card.textContent).toContain("boundary.description");
		expect(card.textContent).toContain("render failed");

		state.broken = false;
		fireEvent.click(screen.getByRole("button", { name: "boundary.tryAgain" }));
		expect(onReset).toHaveBeenCalledOnce();
		expect(screen.getByTestId("child")).toBeTruthy();
	});

	it("uses the description it is given", () => {
		render(
			<ErrorBoundary description="custom text">
				<Child />
			</ErrorBoundary>,
		);
		expect(screen.getByRole("alert").textContent).toContain("custom text");
	});

	it("keeps the error for the same reset key and clears it for a new one", () => {
		const { rerender } = render(
			<ErrorBoundary resetKey="a">
				<Child />
			</ErrorBoundary>,
		);
		state.broken = false;
		rerender(
			<ErrorBoundary resetKey="a">
				<Child />
			</ErrorBoundary>,
		);
		expect(screen.getByRole("alert")).toBeTruthy();

		rerender(
			<ErrorBoundary resetKey="b">
				<Child />
			</ErrorBoundary>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByTestId("child")).toBeTruthy();
	});

	it("leaves healthy children alone when the reset key changes", () => {
		state.broken = false;
		const { rerender } = render(
			<ErrorBoundary resetKey="a">
				<Child />
			</ErrorBoundary>,
		);
		rerender(
			<ErrorBoundary resetKey="b">
				<Child />
			</ErrorBoundary>,
		);
		expect(screen.getByTestId("child")).toBeTruthy();
	});

	it("renders a custom fallback instead of the card", () => {
		render(
			<ErrorBoundary fallback={<p data-testid="fallback">x</p>}>
				<Child />
			</ErrorBoundary>,
		);
		expect(screen.getByTestId("fallback")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
