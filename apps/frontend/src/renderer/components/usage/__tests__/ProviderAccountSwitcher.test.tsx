/** @vitest-environment jsdom */
/**
 * The usage popover's account switch: the other API-key accounts of the
 * provider shown, the active one marked, one click making another the
 * default; nothing for Claude (its profiles have their own list) nor for a
 * provider with a single account.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { AiAccountsSnapshot } from "../../../../shared/types/ai-accounts";
import { useAiAccountsStore } from "../../../stores/ai-accounts-store";
import { ProviderAccountSwitcher } from "../ProviderAccountSwitcher";

const account = (id: string, name: string, provider = "openai", hasKey = true) => ({
	id,
	provider,
	name,
	hasKey,
	createdAt: "2026-11-27T10:00:00.000Z",
});

let snapshot: AiAccountsSnapshot;
const bridge = {
	listAiAccounts: vi.fn(async () => ({ success: true, data: snapshot })),
	setDefaultAiAccount: vi.fn(async (provider: string, id: string | null) => {
		snapshot = { ...snapshot, defaults: id ? { [provider]: id } : {} };
		return { success: true };
	}),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockClear();
	snapshot = {
		accounts: [account("a1", "Perso"), account("a2", "Client"), account("a3", "Empty", "openai", false)],
		defaults: {},
		mainKeys: ["openai"],
	};
	useAiAccountsStore.setState({ accounts: [], defaults: {}, mainKeys: [], loaded: false, error: null });
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ProviderAccountSwitcher", () => {
	it("lists the provider's accounts with a key, the active one first marked", async () => {
		render(<ProviderAccountSwitcher provider="openai" />);
		expect(await screen.findByText("Perso")).toBeInTheDocument();
		expect(screen.getByText("Client")).toBeInTheDocument();
		expect(screen.queryByText("Empty")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Main key/ })).toHaveAttribute("aria-pressed", "true");
	});

	it("switches the default account in one click", async () => {
		render(<ProviderAccountSwitcher provider="openai" />);
		fireEvent.click(await screen.findByRole("button", { name: /Client/ }));
		await waitFor(() => expect(bridge.setDefaultAiAccount).toHaveBeenCalledWith("openai", "a2"));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Client/ })).toHaveAttribute("aria-pressed", "true"),
		);
		fireEvent.click(screen.getByRole("button", { name: /Main key/ }));
		await waitFor(() => expect(bridge.setDefaultAiAccount).toHaveBeenLastCalledWith("openai", null));
	});

	it("says when a switch is refused", async () => {
		bridge.setDefaultAiAccount.mockResolvedValueOnce({ success: false, error: "Account not found" } as never);
		render(<ProviderAccountSwitcher provider="openai" />);
		fireEvent.click(await screen.findByRole("button", { name: /Perso/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Account not found");
	});

	it("shows nothing for Claude, an unknown provider or a single account", async () => {
		const { container, rerender } = render(<ProviderAccountSwitcher provider="anthropic" />);
		expect(container).toBeEmptyDOMElement();
		rerender(<ProviderAccountSwitcher provider={null} />);
		expect(container).toBeEmptyDOMElement();
		snapshot = { accounts: [account("m1", "Solo", "mistral")], defaults: {}, mainKeys: [] };
		rerender(<ProviderAccountSwitcher provider="mistral" />);
		await waitFor(() => expect(bridge.listAiAccounts).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});
});
