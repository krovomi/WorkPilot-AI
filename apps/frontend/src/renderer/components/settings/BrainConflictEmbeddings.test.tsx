/**
 * The brain's settings: the local embeddings model that finds memory
 * conflicts in other words (#352) — on or off, which model, and a variable
 * that wins shown as such.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

const mockFetchSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchBrainSettings: (...args: unknown[]) => mockFetchSettings(...args),
	saveBrainSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

import { useBrainStore } from "../../stores/brain-store";
import { BrainSettings } from "./BrainSettings";

const embeddings = { enabled: true, model: "", enabledLocked: false, modelLocked: false };

const base = {
	path: "/home/me/.workpilot/brain",
	defaultPath: "/home/me/.workpilot/brain",
	source: "default",
	envVariable: "WORKPILOT_BRAIN_DIR",
	configPath: "/home/me/.workpilot/brain.json",
	enabled: true,
	active: true,
	exists: true,
	folderExists: true,
	git: true,
	gitAvailable: true,
	remote: null,
	obsidianVault: false,
	notes: 3,
	proposals: 0,
	conflictEmbeddings: embeddings,
};

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockFetchSettings.mockReset();
	mockSaveSettings.mockReset();
	useBrainStore.setState({
		settings: null,
		unavailable: false,
		error: null,
		errorDetail: null,
		saving: false,
		lastSync: null,
	});
});
afterEach(cleanup);

it("turns the check off", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockSaveSettings.mockResolvedValue({
		ok: true,
		data: { settings: { ...base, conflictEmbeddings: { ...embeddings, enabled: false } } },
	});
	render(<BrainSettings />);

	const toggle = await screen.findByRole("switch", { name: "Find memory conflicts in other words" });
	expect(toggle).toBeChecked();
	fireEvent.click(toggle);

	await waitFor(() =>
		expect(mockSaveSettings).toHaveBeenCalledWith({ conflict_embeddings: false, connect: false }),
	);
	await waitFor(() => expect(toggle).not.toBeChecked());
});

it("names the model, trimmed, and saves only a change", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockSaveSettings.mockResolvedValue({
		ok: true,
		data: { settings: { ...base, conflictEmbeddings: { ...embeddings, model: "bge-m3" } } },
	});
	render(<BrainSettings />);

	const input = await screen.findByLabelText("Embeddings model");
	const save = screen.getByRole("button", { name: "Save the model" });
	expect(save).toBeDisabled();
	fireEvent.change(input, { target: { value: " bge-m3 " } });
	fireEvent.click(save);

	await waitFor(() =>
		expect(mockSaveSettings).toHaveBeenCalledWith({
			conflict_embeddings_model: "bge-m3",
			connect: false,
		}),
	);
	await waitFor(() => expect(input).toHaveValue("bge-m3"));
	expect(save).toBeDisabled();
});

it("shows a refused model name", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockSaveSettings.mockResolvedValue({ ok: false, error: "invalid-model" });
	render(<BrainSettings />);

	fireEvent.change(await screen.findByLabelText("Embeddings model"), {
		target: { value: "../x" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save the model" }));

	expect(await screen.findByText("That is not an Ollama model name.")).toBeInTheDocument();
});

it("a variable that sets them makes both read-only, in French too", async () => {
	await i18n.changeLanguage("fr");
	mockFetchSettings.mockResolvedValue({
		ok: true,
		data: {
			settings: {
				...base,
				conflictEmbeddings: { ...embeddings, model: "x", enabledLocked: true, modelLocked: true },
			},
		},
	});
	render(<BrainSettings />);

	expect(
		await screen.findByRole("switch", { name: "Trouver les conflits de mémoire formulés autrement" }),
	).toBeDisabled();
	expect(screen.getByLabelText("Modèle d'embeddings")).toBeDisabled();
	expect(
		screen.getByText("Imposé par la variable d'environnement BRAIN_CONFLICT_EMBEDDINGS."),
	).toBeInTheDocument();
	expect(
		screen.getByText("Imposé par la variable d'environnement BRAIN_CONFLICT_EMBEDDINGS_MODEL."),
	).toBeInTheDocument();
});

it("an older backend without the setting shows nothing of it", async () => {
	const { conflictEmbeddings: _gone, ...older } = base;
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: older } });
	render(<BrainSettings />);

	await screen.findByRole("switch", { name: "Plug the brain into WorkPilot" });
	expect(screen.queryByLabelText("Embeddings model")).not.toBeInTheDocument();
});
