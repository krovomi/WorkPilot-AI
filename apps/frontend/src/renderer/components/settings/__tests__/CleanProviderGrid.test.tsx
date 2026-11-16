/**
 * CleanProviderGrid — the providers of Settings → AI accounts: found by name or
 * description, filtered by state with their counts, connected ones first.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { ProviderCardData } from "../CleanProviderCard";
import { CleanProviderGrid } from "../CleanProviderGrid";

const t = (key: string) => i18n.t(`settings:${key}`);

const PROVIDERS: ProviderCardData[] = [
	{ id: "anthropic", name: "Anthropic", description: "Claude models", isConfigured: true },
	{ id: "mistral", name: "Mistral", description: "European models", isConfigured: true, isWorking: false },
	{ id: "ollama", name: "Ollama", isConfigured: false },
	{ id: "openai", name: "OpenAI", description: "GPT", isConfigured: false },
];

afterEach(cleanup);

const names = () => screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const chip = (filter: string) => screen.getByRole("button", { name: new RegExp(`^${t(`aiAccounts.filters.${filter}`)} ·`) });

describe("CleanProviderGrid", () => {
	it("shows the connected providers above the ones to connect, with each filter's count", () => {
		render(<CleanProviderGrid providers={PROVIDERS} defaultProvider="anthropic" onConfigure={vi.fn()} />);
		expect(names()).toEqual(["Anthropic", "Mistral", "Ollama", "OpenAI"]);
		expect(chip("all")).toHaveTextContent("4");
		expect(chip("connected")).toHaveTextContent("2");
		expect(chip("available")).toHaveTextContent("2");
		expect(chip("attention")).toHaveTextContent("1");
		const connected = screen.getByRole("region", { name: new RegExp(t("aiAccounts.groups.connected")) });
		expect(within(connected).getByText(t("aiAccounts.card.default"))).toBeInTheDocument();
	});

	it("filters by state and finds a provider by its name or description", async () => {
		const user = userEvent.setup();
		render(<CleanProviderGrid providers={PROVIDERS} onConfigure={vi.fn()} testingProviders={new Set(["mistral"])} />);
		await user.click(chip("attention"));
		expect(names()).toEqual(["Mistral"]);
		await user.click(chip("available"));
		expect(names()).toEqual(["Ollama", "OpenAI"]);
		await user.click(chip("connected"));
		expect(names()).toEqual(["Anthropic", "Mistral"]);
		await user.click(chip("all"));
		await user.type(screen.getByRole("textbox", { name: t("aiAccounts.search") }), "european");
		expect(names()).toEqual(["Mistral"]);
	});

	it("says when nothing matches", async () => {
		const user = userEvent.setup();
		render(<CleanProviderGrid providers={PROVIDERS} onConfigure={vi.fn()} />);
		await user.type(screen.getByRole("textbox", { name: t("aiAccounts.search") }), "zzz");
		expect(screen.getByText(t("aiAccounts.empty.title"))).toBeInTheDocument();
		expect(names()).toEqual([]);
	});
});
