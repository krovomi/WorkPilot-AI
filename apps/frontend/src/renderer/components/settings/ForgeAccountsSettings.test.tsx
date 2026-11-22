/** @vitest-environment jsdom */
/**
 * Forge accounts in the app settings: an account is added with its token sent
 * once, an edit sends no token unless one is typed, a test shows the login,
 * and an account is deleted after confirmation.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { ForgeAccountView } from "../../../shared/types/forge-accounts";
import { useForgeAccountsStore } from "../../stores/forge-accounts-store";
import { ForgeAccountsSettings } from "./ForgeAccountsSettings";

const confirmAction = vi.fn();
vi.mock("@/components/ui/confirm-dialog", () => ({
	confirmAction: (...args: unknown[]) => confirmAction(...args),
}));

const WORK: ForgeAccountView = {
	id: "a1",
	forge: "gitlab",
	label: "Work",
	host: "https://gitlab.example.com",
	username: "me",
	hasToken: true,
	createdAt: "",
};

const bridge = {
	listForgeAccounts: vi.fn(),
	saveForgeAccount: vi.fn(),
	deleteForgeAccount: vi.fn(),
	testForgeAccount: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	confirmAction.mockReset();
	bridge.listForgeAccounts.mockResolvedValue({ success: true, data: [WORK] });
	bridge.saveForgeAccount.mockResolvedValue({ success: true, data: WORK });
	bridge.deleteForgeAccount.mockResolvedValue({ success: true });
	bridge.testForgeAccount.mockResolvedValue({ success: true, data: { ok: true, username: "me" } });
	useForgeAccountsStore.setState({ accounts: [], loaded: false, error: null });
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ForgeAccountsSettings", () => {
	it("lists the saved accounts with whether a token is set", async () => {
		render(<ForgeAccountsSettings />);
		expect(await screen.findByText("Work")).toBeInTheDocument();
		expect(screen.getByText("https://gitlab.example.com")).toBeInTheDocument();
		expect(screen.getByText("Token saved")).toBeInTheDocument();
	});

	it("says when there is none", async () => {
		bridge.listForgeAccounts.mockResolvedValue({ success: true, data: [] });
		render(<ForgeAccountsSettings />);
		expect(await screen.findByText("No forge account saved yet.")).toBeInTheDocument();
	});

	it("adds an account, its address asked only where the token needs one", async () => {
		render(<ForgeAccountsSettings />);
		fireEvent.click(await screen.findByRole("button", { name: "Add an account" }));
		expect(screen.queryByLabelText("GitLab instance")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "gitlab" } });
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client" } });
		fireEvent.change(screen.getByLabelText("GitLab instance"), {
			target: { value: "gitlab.client.example" },
		});
		const token = screen.getByLabelText("Token");
		expect(token).toHaveAttribute("type", "password");
		fireEvent.change(token, { target: { value: "pat-test-0000" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(bridge.saveForgeAccount).toHaveBeenCalledWith({
				forge: "gitlab",
				label: "Client",
				host: "gitlab.client.example",
				username: undefined,
				token: "pat-test-0000",
			}),
		);
		await waitFor(() => expect(screen.queryByLabelText("Token")).not.toBeInTheDocument());
	});

	it("asks Bitbucket for the username its token signs in with", async () => {
		render(<ForgeAccountsSettings />);
		fireEvent.click(await screen.findByRole("button", { name: "Add an account" }));
		fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "bitbucket" } });
		expect(screen.getByLabelText("Username or email (optional)")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Forge"), { target: { value: "azure_devops" } });
		expect(screen.getByLabelText("Azure DevOps organization")).toBeInTheDocument();
	});

	it("edits an account without sending a token, and shows a refusal", async () => {
		bridge.saveForgeAccount.mockResolvedValue({ success: false, error: "Invalid address" });
		render(<ForgeAccountsSettings />);
		fireEvent.click(await screen.findByRole("button", { name: "Edit Work" }));
		expect(screen.getByLabelText("Token")).toHaveAttribute(
			"placeholder",
			"Leave empty to keep the saved token",
		);
		expect(screen.getByLabelText("Forge")).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(bridge.saveForgeAccount).toHaveBeenCalledWith(
				expect.objectContaining({ id: "a1", token: undefined, username: "me" }),
			),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid address");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("tests an account and shows the login or the reason", async () => {
		render(<ForgeAccountsSettings />);
		fireEvent.click(await screen.findByRole("button", { name: "Test" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Connected as me");
		bridge.testForgeAccount.mockResolvedValue({ success: true, data: { ok: false, error: "Token refused" } });
		fireEvent.click(screen.getByRole("button", { name: "Test" }));
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("Connection failed: Token refused"),
		);
	});

	it("deletes an account only once confirmed", async () => {
		confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		render(<ForgeAccountsSettings />);
		fireEvent.click(await screen.findByRole("button", { name: "Delete Work" }));
		await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
		expect(bridge.deleteForgeAccount).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
		await waitFor(() => expect(bridge.deleteForgeAccount).toHaveBeenCalledWith("a1"));
	});

	it("shows why the accounts could not be read", async () => {
		bridge.listForgeAccounts.mockResolvedValue({ success: false, error: "Unreadable" });
		render(<ForgeAccountsSettings />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Unreadable");
	});
});
