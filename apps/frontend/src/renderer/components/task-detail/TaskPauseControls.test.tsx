/**
 * @vitest-environment jsdom
 */
/**
 * Tests TaskPauseControls — le bloc « Changer de LLM en cours d'exécution ».
 *
 * Couvre la clarification UX : le bouton de pause/override à chaud n'est
 * actionnable que pendant l'exécution. Hors exécution, il est désactivé (les
 * étapes non démarrées se configurent via les sélecteurs LLM de chaque phase).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

vi.mock("../../stores/settings-store", () => ({
	useSettingsStore: vi.fn(),
}));

vi.mock("../../hooks/use-toast", () => ({
	useToast: () => ({ toast: vi.fn() }),
}));

import type { Task } from "../../../shared/types";
import { useSettingsStore } from "../../stores/settings-store";
import { TooltipProvider } from "../ui/tooltip";
import { TaskPauseControls } from "./TaskPauseControls";

const fakeStoreState = { settings: {}, profiles: [] };

function makeTask(): Task {
	return {
		id: "task-1",
		metadata: {},
	} as unknown as Task;
}

function renderControls(props: Parameters<typeof TaskPauseControls>[0]) {
	return render(
		<TooltipProvider>
			<TaskPauseControls {...props} />
		</TooltipProvider>,
	);
}

beforeEach(() => {
	(useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
		(selector: (s: typeof fakeStoreState) => unknown) =>
			selector(fakeStoreState),
	);
});

describe("TaskPauseControls", () => {
	it("désactive le bouton de pause quand la tâche n'est pas en cours d'exécution", () => {
		renderControls({ task: makeTask(), isPaused: false, isRunning: false });
		const button = screen.getByRole("button", {
			name: /pause and switch llm/i,
		});
		expect(button).toBeDisabled();
	});

	it("active le bouton et déclenche onPause quand la tâche est en cours d'exécution", async () => {
		const onPause = vi.fn().mockResolvedValue(undefined);
		renderControls({
			task: makeTask(),
			isPaused: false,
			isRunning: true,
			onPause,
		});
		const button = screen.getByRole("button", {
			name: /pause and switch llm/i,
		});
		expect(button).toBeEnabled();
		fireEvent.click(button);
		await waitFor(() => expect(onPause).toHaveBeenCalledTimes(1));
	});
});

vi.mock("../../../shared/utils/providers", () => ({
	getStaticProviders: async () => ({
		providers: [{ name: "ollama", label: "Ollama" }],
		status: { ollama: true },
	}),
}));
afterEach(() => vi.unstubAllGlobals());
it("keeps the downloaded phase model and sends its exact ID when resuming", async () => {
	const model = "gemma4:12b-it-q4_K_M";
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({
				source: "live",
				models: [{ value: model, label: model, supports_tools: true }],
			}),
		}),
	);
	const resume = vi.fn().mockResolvedValue({ success: true });
	vi.stubGlobal("electronAPI", { resumeTaskWithProvider: resume });
	const task = {
		id: "task-local",
		metadata: { provider: "ollama", phaseModels: { coding: model } },
	} as unknown as Task;
	renderControls({ task, isPaused: true, isRunning: false });
	await waitFor(() => expect(screen.getByText(model)).toBeInTheDocument());
	const button = screen.getByRole("button", { name: /resume with this llm/i });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
	await waitFor(() =>
		expect(resume).toHaveBeenCalledWith(
			"task-local",
			"ollama",
			model,
			"medium",
		),
	);
});

it("names the paused task and takes its model from the official library", async () => {
	const resume = vi.fn().mockResolvedValue({ success: true });
	vi.stubGlobal("electronAPI", { resumeTaskWithProvider: resume });
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				models: [
					{
						value: "gemma4:12b",
						source: "https://ollama.com/library/gemma4:12b",
					},
				],
			}),
		}),
	);
	const task = {
		id: "custom-task",
		title: "Repair checkout",
		metadata: { provider: "ollama", model: "custom" },
	} as Task;
	renderControls({ task, isPaused: true, isRunning: false });
	expect(screen.getByText("Repair checkout")).toBeInTheDocument();

	// The sentinel is not a model, so resuming on it is refused — and the
	// library search opens on its own rather than leaving the task stuck on a
	// row it cannot resume from.
	const button = screen.getByRole("button", { name: /resume with this llm/i });
	expect(button).toBeDisabled();
	// Nothing is typed: the id can only come from the library listing.
	expect(screen.queryByRole("textbox", { name: "Model ID" })).toBeNull();

	const option = await screen.findByRole("option", { name: "gemma4:12b" });
	fireEvent.click(option);

	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
	await waitFor(() =>
		expect(resume).toHaveBeenCalledWith(
			"custom-task",
			"ollama",
			"gemma4:12b",
			"medium",
		),
	);
});
