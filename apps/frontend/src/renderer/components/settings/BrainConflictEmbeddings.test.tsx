/**
 * The brain's settings: the local embeddings model that finds memory
 * conflicts in other words (#352) — on or off, which local server (Ollama,
 * LM Studio) and model, which one was found, and a variable that wins shown
 * as such.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

const mockFetchSettings = vi.fn();
const mockSaveSettings = vi.fn();
const mockFetchFound = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchBrainSettings: (...args: unknown[]) => mockFetchSettings(...args),
	saveBrainSettings: (...args: unknown[]) => mockSaveSettings(...args),
	fetchBrainEmbeddingsFound: (...args: unknown[]) => mockFetchFound(...args),
}));

import { useBrainStore } from "../../stores/brain-store";
import { BrainSettings } from "./BrainSettings";

const embeddings = {
	enabled: true,
	model: "",
	enabledLocked: false,
	modelLocked: false,
	provider: "",
	providerLocked: false,
};

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
	mockFetchFound.mockReset();
	mockFetchFound.mockResolvedValue({ ok: true, data: { found: null } });
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

	expect(await screen.findByText("That is not a local model name.")).toBeInTheDocument();
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

it("says which local server and model were found", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockFetchFound.mockResolvedValue({
		ok: true,
		data: { found: { provider: "lm-studio", model: "text-embedding-bge-m3" } },
	});
	render(<BrainSettings />);

	expect(
		await screen.findByText("Found: text-embedding-bge-m3 in LM Studio."),
	).toBeInTheDocument();
});

it("says so in French, for Ollama", async () => {
	await i18n.changeLanguage("fr");
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockFetchFound.mockResolvedValue({
		ok: true,
		data: { found: { provider: "ollama", model: "bge-m3:latest" } },
	});
	render(<BrainSettings />);

	expect(await screen.findByText("Trouvé : bge-m3:latest dans Ollama.")).toBeInTheDocument();
	expect(screen.getByLabelText("Serveur local")).toHaveValue("");
	expect(screen.getByText("Automatique : Ollama, sinon LM Studio")).toBeInTheDocument();
});

it("says when no local model was found, and looks while it asks", async () => {
	let answer: (value: unknown) => void = () => undefined;
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockFetchFound.mockReturnValue(
		new Promise((resolve) => {
			answer = resolve;
		}),
	);
	render(<BrainSettings />);

	expect(await screen.findByText("Looking for a local embeddings model…")).toBeInTheDocument();
	answer({ ok: true, data: { found: null } });
	expect(
		await screen.findByText("No local embeddings model found: only shared words count."),
	).toBeInTheDocument();
});

it("an older backend without the route says nothing of what was found", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockFetchFound.mockResolvedValue({ ok: false, error: "request failed with HTTP 404" });
	render(<BrainSettings />);

	await screen.findByLabelText("Local server");
	await waitFor(() =>
		expect(screen.queryByText("Looking for a local embeddings model…")).not.toBeInTheDocument(),
	);
	expect(screen.queryByText(/^Found:/)).not.toBeInTheDocument();
	expect(screen.queryByText(/No local embeddings model/)).not.toBeInTheDocument();
});

it("switched off, nothing is asked nor said", async () => {
	mockFetchSettings.mockResolvedValue({
		ok: true,
		data: { settings: { ...base, conflictEmbeddings: { ...embeddings, enabled: false } } },
	});
	render(<BrainSettings />);

	await screen.findByLabelText("Local server");
	expect(mockFetchFound).not.toHaveBeenCalled();
	expect(screen.queryByText("Looking for a local embeddings model…")).not.toBeInTheDocument();
});

it("chooses the local server and asks again once saved", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockSaveSettings.mockResolvedValue({
		ok: true,
		data: {
			settings: { ...base, conflictEmbeddings: { ...embeddings, provider: "lm-studio" } },
		},
	});
	render(<BrainSettings />);

	const select = await screen.findByLabelText("Local server");
	await waitFor(() => expect(mockFetchFound).toHaveBeenCalledTimes(1));
	expect(screen.getByText("A server chosen here is the only one asked.")).toBeInTheDocument();
	fireEvent.change(select, { target: { value: "lm-studio" } });

	await waitFor(() =>
		expect(mockSaveSettings).toHaveBeenCalledWith({
			conflict_embeddings_provider: "lm-studio",
			connect: false,
		}),
	);
	await waitFor(() => expect(select).toHaveValue("lm-studio"));
	await waitFor(() => expect(mockFetchFound).toHaveBeenCalledTimes(2));
});

it("shows a refused provider", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockSaveSettings.mockResolvedValue({ ok: false, error: "invalid-provider" });
	render(<BrainSettings />);

	fireEvent.change(await screen.findByLabelText("Local server"), {
		target: { value: "ollama" },
	});

	expect(
		await screen.findByText(
			"That is not a local server this check can ask (Ollama or LM Studio).",
		),
	).toBeInTheDocument();
});

it("a provider variable makes the choice read-only", async () => {
	mockFetchSettings.mockResolvedValue({
		ok: true,
		data: {
			settings: {
				...base,
				conflictEmbeddings: { ...embeddings, provider: "ollama", providerLocked: true },
			},
		},
	});
	render(<BrainSettings />);

	expect(await screen.findByLabelText("Local server")).toBeDisabled();
	expect(
		screen.getByText("Set by the environment variable BRAIN_CONFLICT_EMBEDDINGS_PROVIDER."),
	).toBeInTheDocument();
});

it("an older backend without the provider shows no choice", async () => {
	const { provider: _p, providerLocked: _l, ...older } = embeddings;
	mockFetchSettings.mockResolvedValue({
		ok: true,
		data: { settings: { ...base, conflictEmbeddings: older } },
	});
	render(<BrainSettings />);

	await screen.findByLabelText("Embeddings model");
	expect(screen.queryByLabelText("Local server")).not.toBeInTheDocument();
});

it("an answer after the page left is dropped", async () => {
	let answer: (value: unknown) => void = () => undefined;
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockFetchFound.mockReturnValue(
		new Promise((resolve) => {
			answer = resolve;
		}),
	);
	const { unmount } = render(<BrainSettings />);
	await screen.findByText("Looking for a local embeddings model…");
	const [signal] = mockFetchFound.mock.calls[0] as [AbortSignal];
	unmount();

	expect(signal.aborted).toBe(true);
	answer({ ok: true, data: { found: { provider: "ollama", model: "x" } } });
	await Promise.resolve();
});
