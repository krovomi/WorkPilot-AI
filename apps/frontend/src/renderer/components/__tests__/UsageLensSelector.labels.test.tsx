/**
 * The usage lens is the header's only place that names the observed
 * provider (the auth badge beside it is an icon): a provider the settings do
 * not list still shows its proper name, not its id.
 *
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

const lens = vi.hoisted(() => ({
	usageProvider: "anthropic",
	usageProviderChoice: null as string | null,
	setUsageProviderChoice: vi.fn(),
	runningProviders: [] as string[],
}));
const configured = vi.hoisted(() => ({
	providers: [] as { name: string; label: string }[],
}));

vi.mock("../ProviderContext", () => ({ useProviderContext: () => lens }));
vi.mock("../../hooks/useConfiguredProviders", () => ({
	useConfiguredProviders: () => ({ providers: configured.providers, loading: false }),
}));

import { TooltipProvider } from "../ui/tooltip";
import { UsageLensSelector } from "../UsageLensSelector";

function renderLens() {
	return render(
		<TooltipProvider>
			<UsageLensSelector />
		</TooltipProvider>,
	);
}

afterEach(() => {
	cleanup();
	lens.usageProviderChoice = null;
	lens.usageProvider = "anthropic";
	configured.providers = [];
});

beforeAll(async () => {
	await i18n.changeLanguage("en");
});

describe("UsageLensSelector", () => {
	it("names an unlisted provider by its label in automatic mode", () => {
		renderLens();
		const trigger = screen.getByRole("combobox");
		expect(trigger.textContent).toContain("Anthropic");
		expect(trigger.textContent).not.toContain("anthropic");
	});

	it("names an unlisted chosen provider by its label", () => {
		lens.usageProviderChoice = "copilot";
		lens.usageProvider = "copilot";
		renderLens();
		expect(screen.getByRole("combobox").textContent).toContain("GitHub Copilot");
	});

	it("keeps the label the settings give, and the id of a provider nobody knows", () => {
		configured.providers = [{ name: "anthropic", label: "Claude (team)" }];
		renderLens();
		expect(screen.getByRole("combobox").textContent).toContain("Claude (team)");
		cleanup();
		lens.usageProviderChoice = "acme-llm";
		lens.usageProvider = "acme-llm";
		renderLens();
		expect(screen.getByRole("combobox").textContent).toContain("acme-llm");
	});

	it("names an unknown provider in the app's language", async () => {
		lens.usageProvider = "unknown";
		await i18n.changeLanguage("fr");
		try {
			renderLens();
			const trigger = screen.getByRole("combobox");
			expect(trigger.textContent).toContain("Inconnu");
			expect(trigger.textContent).not.toContain("Unknown");
		} finally {
			await i18n.changeLanguage("en");
		}
	});
});
