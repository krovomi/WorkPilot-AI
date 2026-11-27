/** @vitest-environment jsdom */
/**
 * The accounts dialog of a provider card: Claude's profiles, an API-key
 * provider's accounts, or a note for a provider that signs in through its
 * own tool.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import { ProviderAccountsDialog, supportsAccounts } from "../ProviderAccountsDialog";

vi.mock("../ApiKeyAccounts", () => ({
	ApiKeyAccounts: ({ provider }: { provider: string }) => <p>{`api-key ${provider}`}</p>,
}));
vi.mock("../ClaudeAccounts", () => ({ ClaudeAccounts: () => <p>{"claude profiles"}</p> }));

afterEach(cleanup);

describe("ProviderAccountsDialog", () => {
	it("knows which providers have accounts here", () => {
		expect(supportsAccounts("anthropic")).toBe(true);
		expect(supportsAccounts("claude")).toBe(true);
		expect(supportsAccounts("openrouter")).toBe(true);
		expect(supportsAccounts("gemini")).toBe(true);
		expect(supportsAccounts("copilot")).toBe(false);
	});

	it("shows Claude's profiles, an API-key provider's accounts or a note", () => {
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<ProviderAccountsDialog provider={{ id: "anthropic", name: "Anthropic" }} onOpenChange={onOpenChange} />,
		);
		expect(screen.getByRole("dialog", { name: "Anthropic accounts" })).toBeInTheDocument();
		expect(screen.getByText("claude profiles")).toBeInTheDocument();
		rerender(<ProviderAccountsDialog provider={{ id: "gemini", name: "Gemini" }} onOpenChange={onOpenChange} />);
		expect(screen.getByText("api-key google")).toBeInTheDocument();
		rerender(<ProviderAccountsDialog provider={{ id: "copilot", name: "Copilot" }} onOpenChange={onOpenChange} />);
		expect(screen.getByText(/Copilot signs in through its own tool/)).toBeInTheDocument();
		rerender(<ProviderAccountsDialog provider={null} onOpenChange={onOpenChange} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
