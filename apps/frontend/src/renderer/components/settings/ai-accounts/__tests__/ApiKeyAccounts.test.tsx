/** @vitest-environment jsdom */
/**
 * The accounts of an API-key provider: the main key and the saved accounts
 * listed with the default marked, a new account sent with its key once,
 * tested, and made the default when it is the provider's only key; an edit
 * sends no key unless one is typed; the default can go back to the main key.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { AiAccountsSnapshot, AiAccountTestResult } from "../../../../../shared/types/ai-accounts";
import type { IPCResult } from "../../../../../shared/types/common";
import { useAiAccountsStore } from "../../../../stores/ai-accounts-store";
import { ApiKeyAccounts } from "../ApiKeyAccounts";

const confirmAction = vi.fn();
vi.mock("@/components/ui/confirm-dialog", () => ({
	confirmAction: (...args: unknown[]) => confirmAction(...args),
}));

const PERSO = {
	id: "a1",
	provider: "openai",
	name: "Perso",
	hasKey: true,
	createdAt: "2026-11-27T10:00:00.000Z",
	keySetAt: "2026-11-27T10:00:00.000Z",
};

let snapshot: AiAccountsSnapshot;

const bridge = {
	listAiAccounts: vi.fn(async () => ({ success: true, data: snapshot })),
	saveAiAccount: vi.fn(),
	deleteAiAccount: vi.fn(async () => ({ success: true })),
	testAiAccount: vi.fn(
		async (_id: string): Promise<IPCResult<AiAccountTestResult>> => ({
			success: true,
			data: { ok: true, modelCount: 12 },
		}),
	),
	setDefaultAiAccount: vi.fn(async (provider: string, id: string | null) => {
		snapshot = { ...snapshot, defaults: id ? { ...snapshot.defaults, [provider]: id } : {} };
		return { success: true };
	}),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockClear();
	confirmAction.mockReset();
	snapshot = { accounts: [PERSO], defaults: {}, mainKeys: ["openai"] };
	bridge.saveAiAccount.mockImplementation(async (input: { name: string; provider: string }) => {
		const account = { ...PERSO, id: "a2", name: input.name, provider: input.provider };
		snapshot = { ...snapshot, accounts: [...snapshot.accounts, account] };
		return { success: true, data: account };
	});
	useAiAccountsStore.setState({ accounts: [], defaults: {}, mainKeys: [], loaded: false, error: null });
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

function row(id: string): HTMLElement {
	const element = screen
		.getAllByTestId("ai-account")
		.find((candidate) => candidate.getAttribute("data-account") === id);
	if (!element) throw new Error(`no row ${id}`);
	return element;
}

describe("ApiKeyAccounts", () => {
	it("lists the main key as the default, then the saved accounts", async () => {
		render(<ApiKeyAccounts provider="openai" providerName="OpenAI" />);
		expect(await screen.findByText("Perso")).toBeInTheDocument();
		expect(within(row("main")).getByText("Default")).toBeInTheDocument();
		expect(within(row("a1")).queryByText("Default")).not.toBeInTheDocument();
		expect(within(row("a1")).getByRole("button", { name: /Use by default/ })).toBeInTheDocument();
	});

	it("makes an account the default, and goes back to the main key", async () => {
		render(<ApiKeyAccounts provider="openai" providerName="OpenAI" />);
		await screen.findByText("Perso");
		fireEvent.click(within(row("a1")).getByRole("button", { name: /Use by default/ }));
		await waitFor(() => expect(within(row("a1")).getByText("Default")).toBeInTheDocument());
		expect(bridge.setDefaultAiAccount).toHaveBeenCalledWith("openai", "a1");
		fireEvent.click(within(row("main")).getByRole("button", { name: /Use by default/ }));
		await waitFor(() => expect(bridge.setDefaultAiAccount).toHaveBeenLastCalledWith("openai", null));
	});

	it("adds an account with its key, tests it and makes the only key the default", async () => {
		snapshot = { accounts: [], defaults: {}, mainKeys: [] };
		render(<ApiKeyAccounts provider="mistral" providerName="Mistral" />);
		expect(await screen.findByText("No account yet.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Add an account" }));
		const submit = screen.getByRole("button", { name: "Add and test" });
		expect(submit).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client" } });
		const key = screen.getByLabelText("API key");
		expect(key).toHaveAttribute("type", "password");
		fireEvent.change(key, { target: { value: "sk-test-0000" } });
		fireEvent.click(submit);
		await waitFor(() =>
			expect(bridge.saveAiAccount).toHaveBeenCalledWith({
				provider: "mistral",
				name: "Client",
				apiKey: "sk-test-0000",
			}),
		);
		await waitFor(() => expect(bridge.setDefaultAiAccount).toHaveBeenCalledWith("mistral", "a2"));
		expect(bridge.testAiAccount).toHaveBeenCalledWith("a2");
		expect(await screen.findByText("The account answers (12 models available).")).toBeInTheDocument();
	});

	it("keeps the default when the provider already has a key", async () => {
		render(<ApiKeyAccounts provider="openai" providerName="OpenAI" />);
		await screen.findByText("Perso");
		fireEvent.click(screen.getByRole("button", { name: "Add an account" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work" } });
		fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test-1111" } });
		fireEvent.click(screen.getByRole("button", { name: "Add and test" }));
		await waitFor(() => expect(bridge.testAiAccount).toHaveBeenCalledWith("a2"));
		expect(bridge.setDefaultAiAccount).not.toHaveBeenCalled();
	});

	it("renames an account without sending a key", async () => {
		render(<ApiKeyAccounts provider="openai" providerName="OpenAI" />);
		await screen.findByText("Perso");
		fireEvent.click(screen.getByRole("button", { name: "Edit Perso" }));
		expect(screen.getByLabelText("API key")).toHaveAttribute(
			"placeholder",
			"Leave empty to keep the saved key",
		);
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Personal" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(bridge.saveAiAccount).toHaveBeenCalledWith({
				id: "a1",
				provider: "openai",
				name: "Personal",
				apiKey: undefined,
			}),
		);
	});

	it("shows why a save was refused", async () => {
		bridge.saveAiAccount.mockResolvedValueOnce({ success: false, error: "Invalid key" });
		render(<ApiKeyAccounts provider="openai" providerName="OpenAI" />);
		await screen.findByText("Perso");
		fireEvent.click(screen.getByRole("button", { name: "Add an account" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
		fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
		fireEvent.click(screen.getByRole("button", { name: "Add and test" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid key");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("tests an account and shows a failure", async () => {
		bridge.testAiAccount.mockResolvedValueOnce({ success: true, data: { ok: false, error: "HTTP 401" } });
		render(<ApiKeyAccounts provider="openai" providerName="OpenAI" />);
		await screen.findByText("Perso");
		fireEvent.click(within(row("a1")).getByRole("button", { name: /Test/ }));
		expect(await screen.findByText("Test failed: HTTP 401")).toBeInTheDocument();
	});

	it("deletes an account after confirmation, warning when it is the default", async () => {
		snapshot = { ...snapshot, defaults: { openai: "a1" } };
		confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		render(<ApiKeyAccounts provider="openai" providerName="OpenAI" />);
		await screen.findByText("Perso");
		fireEvent.click(screen.getByRole("button", { name: "Delete Perso" }));
		await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
		expect(bridge.deleteAiAccount).not.toHaveBeenCalled();
		expect(confirmAction.mock.calls[0][0].description).toContain("default account");
		fireEvent.click(screen.getByRole("button", { name: "Delete Perso" }));
		await waitFor(() => expect(bridge.deleteAiAccount).toHaveBeenCalledWith("a1"));
	});
});
