import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DECOR_IDS } from "../../../lib/pixel-office-seasons";
import { CosmeticsPanel } from "../CosmeticsPanel";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

const open = () =>
	fireEvent.click(screen.getByRole("button", { name: "Choose how the office looks" }));

describe("CosmeticsPanel", () => {
	it("offers the open skins, keeps neon locked, and says decor is to earn", () => {
		const onChange = vi.fn();
		render(<CosmeticsPanel earned={[]} hidden={[]} skin="provider" onChange={onChange} />);
		open();
		const neon = screen.getByRole("button", { name: "Neon" }) as HTMLButtonElement;
		expect(neon.disabled).toBe(true);
		expect(screen.getByText(/Neon is a reward/)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Provider colours" }).getAttribute("aria-pressed"),
		).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Their own colours" }));
		expect(onChange).toHaveBeenCalledWith({ agentSkin: "classic" });
		expect(screen.getByText("Meet a goal to decorate the office.")).toBeTruthy();
	});

	it("shows and hides each piece of earned decor, and unlocks neon with all of it", () => {
		const onChange = vi.fn();
		render(
			<CosmeticsPanel
				earned={[...DECOR_IDS]}
				hidden={["plants"]}
				skin="neon"
				onChange={onChange}
			/>,
		);
		open();
		expect(screen.getByText(/Neon earned/)).toBeTruthy();
		expect((screen.getByRole("button", { name: "Neon" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
		const plants = screen.getByRole("switch", { name: "potted plants" });
		expect(plants.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(plants);
		expect(onChange).toHaveBeenLastCalledWith({ hiddenDecor: [] });
		fireEvent.click(screen.getByRole("switch", { name: "an arcade cabinet" }));
		expect(onChange).toHaveBeenLastCalledWith({ hiddenDecor: ["plants", "arcade"] });
	});
});
