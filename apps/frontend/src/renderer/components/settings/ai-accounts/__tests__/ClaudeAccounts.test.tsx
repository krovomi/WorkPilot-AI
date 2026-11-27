/** @vitest-environment jsdom */
/**
 * Claude's accounts in Settings → AI accounts: its OAuth profiles listed with
 * the active one as the default, another made the default, an account added
 * then signed in through the embedded terminal, renamed and deleted.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { ClaudeProfile } from "../../../../../shared/types";
import { claudeProfileSlug, ClaudeAccounts } from "../ClaudeAccounts";

const confirmAction = vi.fn();
vi.mock("@/components/ui/confirm-dialog", () => ({
	confirmAction: (...args: unknown[]) => confirmAction(...args),
}));
vi.mock("../../AuthTerminal", () => ({
	AuthTerminal: ({ profileName, onAuthSuccess }: { profileName: string; onAuthSuccess: () => void }) => (
		<button type="button" onClick={onAuthSuccess}>
			{`terminal ${profileName}`}
		</button>
	),
}));

const profile = (id: string, name: string, extra: Partial<ClaudeProfile> = {}): ClaudeProfile => ({
	id,
	name,
	isDefault: false,
	createdAt: new Date(0),
	isAuthenticated: true,
	...extra,
});

let profiles: ClaudeProfile[];
let activeProfileId: string;

const bridge = {
	getClaudeProfiles: vi.fn(async () => ({ success: true, data: { profiles, activeProfileId } })),
	setActiveClaudeProfile: vi.fn(async (id: string) => {
		activeProfileId = id;
		return { success: true };
	}),
	requestAllProfilesUsage: vi.fn(),
	saveClaudeProfile: vi.fn(async (input: ClaudeProfile) => {
		profiles = [...profiles, { ...input, isAuthenticated: false }];
		return { success: true, data: input };
	}),
	authenticateClaudeProfile: vi.fn(async () => ({
		success: true,
		data: { terminalId: "t1", configDir: "/tmp/p" },
	})),
	renameClaudeProfile: vi.fn(async () => ({ success: true })),
	deleteClaudeProfile: vi.fn(async () => ({ success: true })),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockClear();
	confirmAction.mockReset();
	profiles = [
		profile("default", "Primary", { isDefault: true, email: "me@example.com" }),
		profile("p2", "Work", { isAuthenticated: false }),
	];
	activeProfileId = "default";
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

describe("ClaudeAccounts", () => {
	it("makes a folder name from a profile name", () => {
		expect(claudeProfileSlug(" Client X / 2 ")).toBe("client-x-2");
		expect(claudeProfileSlug("!!!")).toBe("");
	});

	it("lists the profiles, the active one as the default", async () => {
		render(<ClaudeAccounts />);
		expect(await screen.findByText("me@example.com")).toBeInTheDocument();
		expect(within(row("default")).getByText("Default")).toBeInTheDocument();
		expect(within(row("p2")).getByText("Not signed in")).toBeInTheDocument();
		// A profile not signed in cannot become the default, and the default profile cannot be deleted.
		expect(within(row("p2")).queryByRole("button", { name: /Use by default/ })).not.toBeInTheDocument();
		expect(within(row("default")).queryByRole("button", { name: "Delete Primary" })).not.toBeInTheDocument();
	});

	it("makes a signed-in profile the default", async () => {
		profiles[1].isAuthenticated = true;
		render(<ClaudeAccounts />);
		await screen.findByText("Work");
		fireEvent.click(within(row("p2")).getByRole("button", { name: /Use by default/ }));
		await waitFor(() => expect(bridge.setActiveClaudeProfile).toHaveBeenCalledWith("p2"));
		expect(bridge.requestAllProfilesUsage).toHaveBeenCalled();
	});

	it("adds a profile and signs it in through the embedded terminal", async () => {
		render(<ClaudeAccounts />);
		await screen.findByText("Work");
		fireEvent.click(screen.getByRole("button", { name: "Add an account" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client X" } });
		fireEvent.click(screen.getByRole("button", { name: "Add and sign in" }));
		await waitFor(() =>
			expect(bridge.saveClaudeProfile).toHaveBeenCalledWith(
				expect.objectContaining({ name: "Client X", configDir: "~/.claude-profiles/client-x" }),
			),
		);
		const terminal = await screen.findByRole("button", { name: "terminal Client X" });
		fireEvent.click(terminal);
		await waitFor(() => expect(screen.queryByText("terminal Client X")).not.toBeInTheDocument());
	});

	it("refuses a name without a letter or digit", async () => {
		render(<ClaudeAccounts />);
		await screen.findByText("Work");
		fireEvent.click(screen.getByRole("button", { name: "Add an account" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "!!!" } });
		fireEvent.click(screen.getByRole("button", { name: "Add and sign in" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Use at least one letter or digit");
		expect(bridge.saveClaudeProfile).not.toHaveBeenCalled();
	});

	it("says when a sign-in cannot start", async () => {
		bridge.authenticateClaudeProfile.mockResolvedValueOnce({ success: false, error: "No terminal" } as never);
		render(<ClaudeAccounts />);
		await screen.findByText("Work");
		fireEvent.click(within(row("p2")).getByRole("button", { name: /Sign in/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("No terminal");
	});

	it("renames and deletes a profile", async () => {
		confirmAction.mockResolvedValue(true);
		render(<ClaudeAccounts />);
		await screen.findByText("Work");
		fireEvent.click(screen.getByRole("button", { name: "Rename Work" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Job" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bridge.renameClaudeProfile).toHaveBeenCalledWith("p2", "Job"));
		fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
		await waitFor(() => expect(bridge.deleteClaudeProfile).toHaveBeenCalledWith("p2"));
	});

	it("shows a refusal from the profile manager", async () => {
		bridge.deleteClaudeProfile.mockResolvedValueOnce({ success: false, error: "In use" } as never);
		confirmAction.mockResolvedValue(true);
		render(<ClaudeAccounts />);
		await screen.findByText("Work");
		fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("In use");
	});
});
