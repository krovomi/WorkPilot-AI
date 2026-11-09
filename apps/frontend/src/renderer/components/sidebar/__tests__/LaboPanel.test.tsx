/**
 * @vitest-environment jsdom
 *
 * The Labo lists the beta pages, one card each with what it does.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { Leaf, ShieldAlert } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import enNavigation from "@shared/i18n/locales/en/navigation.json";
import frNavigation from "@shared/i18n/locales/fr/navigation.json";
import { EXPERIMENTAL_VIEWS } from "../experimental-views";
import { LaboPanel } from "../LaboPanel";
import type { NavItem } from "../nav-model";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const items: NavItem[] = [
	{ id: "carbon-profiler", labelKey: "items.carbonProfiler", icon: Leaf },
	{ id: "regression-guardian", labelKey: "items.regressionGuardian", icon: ShieldAlert },
];

describe("LaboPanel", () => {
	it("shows a card per page with its sentence, the page on screen marked", () => {
		render(<LaboPanel items={items} activeView="carbon-profiler" disabled={false} onOpen={vi.fn()} />);
		expect(screen.getByText("labo.about.regression-guardian")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /items\.carbonProfiler/ })).toHaveAttribute("aria-current", "page");
	});

	it("opens the page chosen", () => {
		const onOpen = vi.fn();
		render(<LaboPanel items={items} activeView="kanban" disabled={false} onOpen={onOpen} />);
		fireEvent.click(screen.getByRole("button", { name: /items\.regressionGuardian/ }));
		expect(onOpen).toHaveBeenCalledWith(items[1]);
	});

	it("has a sentence for every beta view, in English and French", () => {
		for (const resource of [enNavigation, frNavigation]) {
			const about: Record<string, string> = resource.labo.about;
			for (const view of EXPERIMENTAL_VIEWS) {
				expect(typeof about[view], view).toBe("string");
			}
		}
	});
});
