/** @vitest-environment jsdom */
/**
 * A project picks one of the saved accounts of its forge, or its own token;
 * an account that was deleted is named as such.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import { useForgeAccountsStore } from "../../../../stores/forge-accounts-store";
import { ForgeAccountPicker } from "../ForgeAccountPicker";

const listForgeAccounts = vi.fn();

beforeEach(() => {
	listForgeAccounts.mockResolvedValue({
		success: true,
		data: [
			{ id: "gh1", forge: "github", label: "Work", host: "https://github.com", username: "octo", hasToken: true, createdAt: "" },
			{ id: "gh2", forge: "github", label: "Perso", host: "https://github.com", hasToken: true, createdAt: "" },
			{ id: "gl1", forge: "gitlab", label: "Client", host: "https://gitlab.com", hasToken: true, createdAt: "" },
		],
	});
	useForgeAccountsStore.setState({ accounts: [], loaded: false, error: null });
	(globalThis as { electronAPI?: unknown }).electronAPI = { listForgeAccounts };
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ForgeAccountPicker", () => {
	it("offers the project's own token and the accounts of its forge only", async () => {
		const onChange = vi.fn();
		render(<ForgeAccountPicker forge="github" value="" onChange={onChange} />);
		expect(await screen.findByRole("option", { name: "Work (octo)" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Perso" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "Client" })).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: "This project's own token" })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Account"), { target: { value: "gh2" } });
		expect(onChange).toHaveBeenCalledWith("gh2");
	});

	it("names an account that was deleted", async () => {
		render(<ForgeAccountPicker forge="gitlab" value="gone" onChange={vi.fn()} />);
		expect(await screen.findByRole("option", { name: "Deleted account" })).toBeInTheDocument();
		expect(screen.getByText(/was deleted/)).toBeInTheDocument();
	});

	it("explains where accounts are saved when the forge has none", async () => {
		render(<ForgeAccountPicker forge="azure_devops" value={undefined} onChange={vi.fn()} />);
		await waitFor(() => expect(listForgeAccounts).toHaveBeenCalledTimes(1));
		expect(await screen.findByText(/save it once in Settings/)).toBeInTheDocument();
	});
});
