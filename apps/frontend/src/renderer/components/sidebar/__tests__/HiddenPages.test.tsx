/**
 * @vitest-environment jsdom
 *
 * The offer to hide the pages of a space nobody opened for a month, and the
 * list of the pages hidden, each to show again.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { Lightbulb, Map as MapIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { HiddenList, HideSuggestion } from "../HiddenPages";
import type { NavItem } from "../nav-model";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

const pages: NavItem[] = [
	{ id: "ideation", labelKey: "items.ideation", icon: Lightbulb },
	{ id: "roadmap", labelKey: "items.roadmap", icon: MapIcon },
];

describe("HideSuggestion", () => {
	it("says how many pages and hides nothing until asked", () => {
		const onHide = vi.fn();
		render(<HideSuggestion unused={pages} onHide={onHide} onSnooze={vi.fn()} />);
		expect(screen.getByText(/hidden\.suggest:.*"count":2/)).toBeInTheDocument();
		expect(screen.getByRole("list", { hidden: true })).not.toBeVisible();
		expect(onHide).not.toHaveBeenCalled();
	});

	it("hides one page, or all of them, from the list", () => {
		const onHide = vi.fn();
		render(<HideSuggestion unused={pages} onHide={onHide} onSnooze={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "hidden.review" }));
		fireEvent.click(screen.getByRole("button", { name: /hidden\.hideOne:.*items\.roadmap/ }));
		expect(onHide).toHaveBeenLastCalledWith(["roadmap"]);
		fireEvent.click(screen.getByRole("button", { name: /hidden\.hideAll/ }));
		expect(onHide).toHaveBeenLastCalledWith(["ideation", "roadmap"]);
	});

	it("can be put off", () => {
		const onSnooze = vi.fn();
		render(<HideSuggestion unused={pages} onHide={vi.fn()} onSnooze={onSnooze} />);
		fireEvent.click(screen.getByRole("button", { name: "hidden.later" }));
		expect(onSnooze).toHaveBeenCalledOnce();
	});

	it("shows nothing when every page is used", () => {
		const { container } = render(<HideSuggestion unused={[]} onHide={vi.fn()} onSnooze={vi.fn()} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("HiddenList", () => {
	it("folds the hidden pages under one line and shows one again", () => {
		const onShow = vi.fn();
		render(<HiddenList hidden={pages} onShow={onShow} />);
		const toggle = screen.getByRole("button", { name: /hidden\.count:.*"count":2/ });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(toggle);
		fireEvent.click(screen.getAllByRole("button", { name: "hidden.show" })[1]);
		expect(onShow).toHaveBeenCalledWith("roadmap");
	});
});
