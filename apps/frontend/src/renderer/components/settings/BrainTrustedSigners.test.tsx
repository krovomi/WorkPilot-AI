/**
 * The vault's trusted signers in Settings → Brain (#352): the keys whose
 * signed commits let a note outside every project reach the agents. Shown
 * once the backend answers; edited here, since the vault has no maintainers.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

const mockFetch = vi.fn();
const mockSave = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchBrainVaultSigners: (...args: unknown[]) => mockFetch(...args),
	saveBrainVaultSigners: (...args: unknown[]) => mockSave(...args),
}));

import { BrainTrustedSigners } from "./BrainTrustedSigners";

const none = { signers: [], rejected: 0, signing: true, unverified: 0 };
const alice = { name: "alice@example.com", kind: "ssh", fingerprint: "SHA256:abc" };

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockFetch.mockReset();
	mockSave.mockReset();
});
afterEach(cleanup);

it("says no list keeps every shared note going to the agents", async () => {
	mockFetch.mockResolvedValue({ ok: true, data: none });
	render(<BrainTrustedSigners />);

	expect(
		await screen.findByText("No trusted signer: every shared note reaches the agents, as before."),
	).toBeInTheDocument();
	expect(screen.queryByText(/unverified/)).not.toBeInTheDocument();
});

it("names the keys, never shows them, and warns of what is set aside", async () => {
	mockFetch.mockResolvedValue({
		ok: true,
		data: { signers: [alice], rejected: 2, signing: false, unverified: 1 },
	});
	render(<BrainTrustedSigners />);

	expect(await screen.findByText("Trusted: alice@example.com (ssh)")).toBeInTheDocument();
	expect(
		screen.getByText("1 shared note is unverified: readable here, kept out of the agents."),
	).toBeInTheDocument();
	expect(
		screen.getByText(
			"2 changes to this list were not signed by a listed key and are ignored.",
		),
	).toBeInTheDocument();
	expect(screen.getByText(/does not sign its commits/)).toBeInTheDocument();
});

it("saves the edited list, one key per line", async () => {
	mockFetch.mockResolvedValue({ ok: true, data: none });
	mockSave.mockResolvedValue({
		ok: true,
		data: { signers: [alice], rejected: 0, signing: true, unverified: 0 },
	});
	render(<BrainTrustedSigners />);

	fireEvent.click(await screen.findByRole("button", { name: "Edit the list" }));
	fireEvent.change(screen.getByLabelText(/One per line/), {
		target: { value: " alice@example.com ssh-ed25519 AAAA \n\n" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save" }));

	await waitFor(() =>
		expect(mockSave).toHaveBeenCalledWith(["alice@example.com ssh-ed25519 AAAA"]),
	);
	expect(await screen.findByText("Trusted: alice@example.com (ssh)")).toBeInTheDocument();
	expect(screen.queryByLabelText(/One per line/)).not.toBeInTheDocument();
});

it.each([
	["invalid", "A line is neither an SSH public key nor a GPG fingerprint after a one-word name."],
	["no-brain", "Create the brain first."],
	["request failed with HTTP 500", "The list could not be saved."],
])("shows a refusal (%s)", async (code, text) => {
	mockFetch.mockResolvedValue({ ok: true, data: none });
	mockSave.mockResolvedValue({ ok: false, error: code });
	render(<BrainTrustedSigners />);

	fireEvent.click(await screen.findByRole("button", { name: "Edit the list" }));
	fireEvent.click(screen.getByRole("button", { name: "Save" }));

	expect(await screen.findByRole("alert")).toHaveTextContent(text);
});

it("cancels an edit, in French too", async () => {
	await i18n.changeLanguage("fr");
	mockFetch.mockResolvedValue({ ok: true, data: none });
	render(<BrainTrustedSigners />);

	fireEvent.click(await screen.findByRole("button", { name: "Modifier la liste" }));
	expect(screen.getByLabelText(/Une par ligne/)).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
	expect(screen.queryByLabelText(/Une par ligne/)).not.toBeInTheDocument();
	expect(screen.getByText("Signataires de confiance des notes partagées")).toBeInTheDocument();
});

it("an older backend shows nothing of it", async () => {
	mockFetch.mockResolvedValue({ ok: false, error: "request failed with HTTP 404" });
	const { container } = render(<BrainTrustedSigners />);
	await waitFor(() => expect(mockFetch).toHaveBeenCalled());
	expect(container).toBeEmptyDOMElement();
});

it("an answer after the page left is dropped", async () => {
	let answer: (value: unknown) => void = () => undefined;
	mockFetch.mockReturnValue(
		new Promise((resolve) => {
			answer = resolve;
		}),
	);
	const { unmount } = render(<BrainTrustedSigners />);
	await waitFor(() => expect(mockFetch).toHaveBeenCalled());
	const [signal] = mockFetch.mock.calls[0] as [AbortSignal];
	unmount();
	expect(signal.aborted).toBe(true);
	answer({ ok: true, data: none });
	await Promise.resolve();
});
