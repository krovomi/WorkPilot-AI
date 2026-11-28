/** @vitest-environment jsdom */
/**
 * The accounts dialog of a provider card: Claude's profiles, an API-key
 * provider's accounts, a CLI's sign-ins (OpenAI: both), or a note for a
 * provider that signs in through another tool.
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
vi.mock("../LoginAccounts", () => ({
	LoginAccounts: ({ provider }: { provider: string }) => <p>{`login ${provider}`}</p>,
}));

afterEach(cleanup);

describe("ProviderAccountsDialog", () => {
	it("knows which providers have accounts here", () => {
		expect(supportsAccounts("anthropic")).toBe(true);
		expect(supportsAccounts("claude")).toBe(true);
		expect(supportsAccounts("openrouter")).toBe(true);
		expect(supportsAccounts("gemini")).toBe(true);
		expect(supportsAccounts("copilot")).toBe(true);
		expect(supportsAccounts("gemini-cli")).toBe(true);
		expect(supportsAccounts("ollama")).toBe(false);
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
		expect(screen.getByText("login copilot")).toBeInTheDocument();
		rerender(<ProviderAccountsDialog provider={{ id: "openai", name: "OpenAI" }} onOpenChange={onOpenChange} />);
		expect(screen.getByText("api-key openai")).toBeInTheDocument();
		expect(screen.getByText("login codex")).toBeInTheDocument();
		rerender(<ProviderAccountsDialog provider={{ id: "ollama", name: "Ollama" }} onOpenChange={onOpenChange} />);
		expect(screen.getByText(/Ollama signs in through its own tool/)).toBeInTheDocument();
		rerender(<ProviderAccountsDialog provider={null} onOpenChange={onOpenChange} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
