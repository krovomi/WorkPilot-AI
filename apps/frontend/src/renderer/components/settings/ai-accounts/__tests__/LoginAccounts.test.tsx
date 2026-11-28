/** @vitest-environment jsdom */
/**
 * A coding-agent CLI's accounts in Settings → AI accounts: the sign-in of
 * this computer as the default until another is chosen, an account added then
 * signed in through the terminal the main process plans, made the default
 * once signed in, renamed and deleted.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { AiAccountSignIn, AiAccountsSnapshot, AiAccountView } from "../../../../../shared/types/ai-accounts";
import { useAiAccountsStore } from "../../../../stores/ai-accounts-store";
import { LoginAccounts } from "../LoginAccounts";

const confirmAction = vi.fn();
vi.mock("@/components/ui/confirm-dialog", () => ({
	confirmAction: (...args: unknown[]) => confirmAction(...args),
}));
const terminalProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("../../AuthTerminal", () => ({
	AuthTerminal: (props: { profileName: string; onClose: () => void }) => {
		terminalProps.last = props;
		return (
			<button type="button" onClick={props.onClose}>
				{`terminal ${props.profileName}`}
			</button>
		);
	},
}));

const view = (id: string, name: string, signedIn: boolean): AiAccountView => ({
	id,
	provider: "copilot",
	name,
	hasKey: false,
	kind: "login",
	signedIn,
	createdAt: "2026-11-28T08:00:00.000Z",
});

const PLAN: AiAccountSignIn = {
	terminalId: "ai-account-login-copilot-1",
	command: "gh auth login --hostname github.com --web",
	env: { GH_CONFIG_DIR: "/accounts/copilot/new" },
};

let snapshot: AiAccountsSnapshot;
const bridge = {
	listAiAccounts: vi.fn(async () => ({ success: true, data: snapshot })),
	saveAiAccount: vi.fn(async (input: { id?: string; provider: string; name: string }) => {
		const saved = view(input.id ?? "new", input.name, false);
		snapshot = {
			...snapshot,
			accounts: [...snapshot.accounts.filter((account) => account.id !== saved.id), saved],
		};
		return { success: true, data: saved };
	}),
	deleteAiAccount: vi.fn(async (id: string) => {
		snapshot = { ...snapshot, accounts: snapshot.accounts.filter((account) => account.id !== id) };
		return { success: true };
	}),
	setDefaultAiAccount: vi.fn(async (provider: string, id: string | null) => {
		snapshot = { ...snapshot, defaults: id ? { [provider]: id } : {} };
		return { success: true };
	}),
	signInAiAccount: vi.fn(async () => ({ success: true, data: PLAN })),
	requestAllProfilesUsage: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockClear();
	confirmAction.mockReset();
	terminalProps.last = null;
	snapshot = {
		accounts: [view("c1", "Work", true), view("c2", "Client", false), { ...view("o1", "Key", false), provider: "openai" }],
		defaults: {},
		mainKeys: [],
	};
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

describe("LoginAccounts", () => {
	it("lists the CLI's accounts, this computer's sign-in as the default", async () => {
		render(<LoginAccounts provider="copilot" />);
		expect(await screen.findByText("Work")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "GitHub CLI sign-ins" })).toBeInTheDocument();
		expect(screen.queryByText("Key")).not.toBeInTheDocument();
		expect(within(row("system")).getByText("Default")).toBeInTheDocument();
		expect(within(row("c1")).getByText("Signed in")).toBeInTheDocument();
		expect(within(row("c2")).getByText("Not signed in")).toBeInTheDocument();
		// Only a signed-in account can become the default.
		expect(within(row("c2")).queryByRole("button", { name: /Use by default/ })).toBeNull();
	});

	it("makes an account the default, then goes back to this computer's sign-in", async () => {
		render(<LoginAccounts provider="copilot" />);
		fireEvent.click(within(await screen.findByTestId("login-accounts")).getByRole("button", { name: /Use by default/ }));
		await waitFor(() => expect(bridge.setDefaultAiAccount).toHaveBeenCalledWith("copilot", "c1"));
		await waitFor(() => expect(within(row("c1")).getByText("Default")).toBeInTheDocument());
		expect(bridge.requestAllProfilesUsage).toHaveBeenCalled();
		fireEvent.click(within(row("system")).getByRole("button", { name: /Use by default/ }));
		await waitFor(() => expect(bridge.setDefaultAiAccount).toHaveBeenLastCalledWith("copilot", null));
	});

	it("says when the default is refused", async () => {
		bridge.setDefaultAiAccount.mockResolvedValueOnce({ success: false, error: "This account is not signed in" } as never);
		render(<LoginAccounts provider="copilot" />);
		fireEvent.click(within(await screen.findByTestId("login-accounts")).getByRole("button", { name: /Use by default/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("This account is not signed in");
	});

	it("adds an account and opens its sign-in terminal on the planned command and folder", async () => {
		render(<LoginAccounts provider="copilot" />);
		fireEvent.click(await screen.findByRole("button", { name: /Add an account/ }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Perso " } });
		fireEvent.click(screen.getByRole("button", { name: /Add and sign in/ }));
		await waitFor(() => expect(bridge.saveAiAccount).toHaveBeenCalledWith({ provider: "copilot", name: "Perso" }));
		const terminal = await screen.findByRole("button", { name: "terminal Perso" });
		expect(bridge.signInAiAccount).toHaveBeenCalledWith("new");
		expect(terminalProps.last).toMatchObject({ loginCommand: PLAN.command, env: PLAN.env, terminalId: PLAN.terminalId });
		const listed = bridge.listAiAccounts.mock.calls.length;
		fireEvent.click(terminal);
		await waitFor(() => expect(bridge.listAiAccounts.mock.calls.length).toBeGreaterThan(listed));
		expect(screen.queryByRole("button", { name: "terminal Perso" })).toBeNull();
	});

	it("says when an account cannot be saved or its sign-in cannot start", async () => {
		bridge.saveAiAccount.mockResolvedValueOnce({ success: false, error: "Too many accounts" } as never);
		render(<LoginAccounts provider="copilot" />);
		fireEvent.click(await screen.findByRole("button", { name: /Add an account/ }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "More" } });
		fireEvent.click(screen.getByRole("button", { name: /Add and sign in/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Too many accounts");

		bridge.signInAiAccount.mockResolvedValueOnce({ success: false } as never);
		fireEvent.click(within(row("c2")).getByRole("button", { name: /Sign in/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The sign-in could not start.");
		bridge.signInAiAccount.mockRejectedValueOnce(new Error("bridge down"));
		fireEvent.click(within(row("c1")).getByRole("button", { name: /Sign in again/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("bridge down");
	});

	it("renames an account, and cancels a rename", async () => {
		render(<LoginAccounts provider="copilot" />);
		fireEvent.click(await screen.findByRole("button", { name: "Rename Work" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Team" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(bridge.saveAiAccount).toHaveBeenCalledWith({ id: "c1", provider: "copilot", name: "Team" }),
		);
		expect(await screen.findByText("Team")).toBeInTheDocument();

		bridge.saveAiAccount.mockResolvedValueOnce({ success: false } as never);
		fireEvent.click(screen.getByRole("button", { name: "Rename Client" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Other" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The account could not be saved.");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("Name")).toBeNull();
	});

	it("deletes an account only once confirmed", async () => {
		confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		render(<LoginAccounts provider="copilot" />);
		fireEvent.click(await screen.findByRole("button", { name: "Delete Client" }));
		await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
		expect(bridge.deleteAiAccount).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete Client" }));
		await waitFor(() => expect(bridge.deleteAiAccount).toHaveBeenCalledWith("c2"));
		await waitFor(() => expect(screen.queryByText("Client")).toBeNull());

		bridge.deleteAiAccount.mockResolvedValueOnce({ success: false, error: "Account not found" } as never);
		confirmAction.mockResolvedValueOnce(true);
		fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Account not found");
	});

	it("names an unknown CLI by its id, and keeps a blank name or a cancelled form from saving", async () => {
		render(<LoginAccounts provider="other-cli" />);
		expect(await screen.findByRole("heading", { name: "other-cli sign-ins" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Add an account/ }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
		const form = screen.getByLabelText("Name").closest("form") as HTMLFormElement;
		fireEvent.submit(form);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("Name")).toBeNull();
		expect(bridge.saveAiAccount).not.toHaveBeenCalled();
	});

	it("keeps a blank rename from saving, and gives a refusal without a reason a short one", async () => {
		render(<LoginAccounts provider="copilot" />);
		fireEvent.click(await screen.findByRole("button", { name: "Rename Work" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
		fireEvent.submit(screen.getByLabelText("Name").closest("form") as HTMLFormElement);
		expect(bridge.saveAiAccount).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		bridge.saveAiAccount.mockResolvedValueOnce({ success: false } as never);
		fireEvent.click(screen.getByRole("button", { name: /Add an account/ }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "More" } });
		fireEvent.click(screen.getByRole("button", { name: /Add and sign in/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The account could not be saved.");

		bridge.signInAiAccount.mockRejectedValueOnce("down");
		fireEvent.click(within(row("c2")).getByRole("button", { name: /Sign in/ }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The sign-in could not start."));
	});
});
