/** @vitest-environment jsdom */
/**
 * My tokens on the server: which are stored is shown, a token is sent once
 * and the field emptied, and a stored one can be removed.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { ServerTokensSettings } from "./ServerTokensSettings";

const bridge = {
	listSecrets: vi.fn(),
	setSecret: vi.fn(),
	deleteSecret: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.listSecrets.mockResolvedValue({ success: true, data: ["gitlab_token"] });
	bridge.setSecret.mockResolvedValue({ success: true });
	bridge.deleteSecret.mockResolvedValue({ success: true });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAuth: bridge };
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ServerTokensSettings", () => {
	it("sends a token once and empties its field", async () => {
		render(<ServerTokensSettings />);
		const field = await screen.findByLabelText(/GitHub token/);
		fireEvent.change(field, { target: { value: "ghp_test0000" } });
		fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
		await waitFor(() =>
			expect(bridge.setSecret).toHaveBeenCalledWith("github_token", "ghp_test0000"),
		);
		await waitFor(() => expect(field).toHaveValue(""));
		expect(field).toHaveAttribute("type", "password");
	});

	it("shows which tokens are stored and removes one", async () => {
		render(<ServerTokensSettings />);
		expect(await screen.findByText("Stored")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Remove from the server" }));
		await waitFor(() => expect(bridge.deleteSecret).toHaveBeenCalledWith("gitlab_token"));
	});

	it("says why the server refused", async () => {
		bridge.setSecret.mockResolvedValue({ success: false, error: "Invalid token" });
		render(<ServerTokensSettings />);
		const field = await screen.findByLabelText(/Linear API key/);
		fireEvent.change(field, { target: { value: "lin_test0000" } });
		fireEvent.click(screen.getAllByRole("button", { name: "Save" })[3]);
		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid token");
	});
});
