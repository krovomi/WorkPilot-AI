/**
 * @vitest-environment jsdom
 *
 * The choice between the essential menu and the full one, asked in « Mon menu ».
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MenuModeCard } from "../MenuModeCard";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) =>
			options?.count === undefined ? key : `${key}:${options.count}`,
	}),
}));

describe("MenuModeCard", () => {
	it("is a titled region that says how many pages « Essentiel » pins", () => {
		render(<MenuModeCard essentialCount={10} onChoose={vi.fn()} />);
		expect(screen.getByRole("region", { name: "menuMode.title" })).toBeInTheDocument();
		expect(screen.getByText("menuMode.essentialHint:10")).toBeInTheDocument();
	});

	it("reports each choice", () => {
		const onChoose = vi.fn();
		render(<MenuModeCard essentialCount={10} onChoose={onChoose} />);
		fireEvent.click(screen.getByRole("button", { name: "menuMode.essential" }));
		expect(onChoose).toHaveBeenLastCalledWith("essential");
		fireEvent.click(screen.getByRole("button", { name: "menuMode.full" }));
		expect(onChoose).toHaveBeenLastCalledWith("full");
	});
});
