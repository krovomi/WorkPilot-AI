/**
 * The Browser Agent recorder (#387): the running session, its steps, the
 * format chosen and the last export.
 *
 * Steps arrive from the main process (`setupBrowserRecorderListeners`, once
 * for the window, `global-listeners.ts`). A step the person removed stays
 * removed even if the recorder updates it later (another character typed in
 * the same field). A check the recorder proposes (a step with `after`)
 * waits in `suggestions` until the person keeps it, which puts it right after
 * its action, or sets it aside. An export sends the ids of the steps kept;
 * the main owns their content.
 */
import { create } from "zustand";
import type {
	ExportDestination,
	RecordedStep,
	RecorderEvent,
	RecorderExportOutcome,
	RecorderStatus,
	TestFormat,
} from "../../shared/types/browser-recorder";

interface BrowserRecorderState {
	status: RecorderStatus;
	steps: RecordedStep[];
	suggestions: RecordedStep[];
	removed: string[];
	truncated: boolean;
	error: string | null;
	format: TestFormat;
	name: string;
	exporting: ExportDestination | null;
	outcome: RecorderExportOutcome | null;

	setFormat: (format: TestFormat) => void;
	setName: (name: string) => void;
	removeStep: (id: string) => void;
	acceptSuggestion: (id: string) => void;
	dismissSuggestion: (id: string) => void;
	handleEvent: (event: RecorderEvent) => void;
	start: (projectPath: string, url: string) => Promise<void>;
	stop: () => Promise<void>;
	exportTo: (projectPath: string, destination: ExportDestination) => Promise<void>;
}

function upsert(steps: RecordedStep[], step: RecordedStep): RecordedStep[] {
	const index = steps.findIndex((s) => s.id === step.id);
	if (index < 0) return [...steps, step];
	return steps.map((s, i) => (i === index ? step : s));
}

/** `steps` with `check` after its action and the checks already kept after it, or at the end. */
export function insertAfterAction(steps: RecordedStep[], check: RecordedStep): RecordedStep[] {
	let index = steps.findIndex((s) => s.id === check.after);
	if (index < 0) return [...steps, check];
	while (index + 1 < steps.length && steps[index + 1].after === check.after) index += 1;
	return [...steps.slice(0, index + 1), check, ...steps.slice(index + 1)];
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const useBrowserRecorderStore = create<BrowserRecorderState>((set, get) => ({
	status: "idle",
	steps: [],
	suggestions: [],
	removed: [],
	truncated: false,
	error: null,
	format: "playwright-ts",
	name: "",
	exporting: null,
	outcome: null,

	setFormat: (format) => set({ format, outcome: null }),
	setName: (name) => set({ name }),
	removeStep: (id) =>
		set((state) => ({
			steps: state.steps.filter((s) => s.id !== id),
			removed: [...state.removed, id],
			outcome: null,
		})),
	acceptSuggestion: (id) =>
		set((state) => {
			const check = state.suggestions.find((s) => s.id === id);
			if (!check) return {};
			return {
				steps: insertAfterAction(state.steps, check),
				suggestions: state.suggestions.filter((s) => s.id !== id),
				outcome: null,
			};
		}),
	dismissSuggestion: (id) =>
		set((state) => ({
			suggestions: state.suggestions.filter((s) => s.id !== id),
			removed: [...state.removed, id],
		})),

	handleEvent: (event) => {
		if (event.type === "step") {
			const { removed, steps } = get();
			if (removed.includes(event.step.id)) return;
			if (event.step.after) {
				if (steps.some((s) => s.id === event.step.id)) return;
				set((state) => ({ suggestions: upsert(state.suggestions, event.step) }));
				return;
			}
			set((state) => ({ steps: upsert(state.steps, event.step) }));
		} else if (event.type === "started") {
			set({ status: "recording", error: null });
		} else if (event.type === "stopped") {
			set({ status: "idle", truncated: event.truncated });
		} else {
			set({ status: "idle", error: event.message });
		}
	},

	start: async (projectPath, url) => {
		set({
			status: "starting",
			steps: [],
			suggestions: [],
			removed: [],
			truncated: false,
			error: null,
			outcome: null,
		});
		try {
			const result = await globalThis.electronAPI.startBrowserRecording(projectPath, url);
			if (!result.success) set({ status: "idle", error: result.error ?? null });
		} catch (error) {
			set({ status: "idle", error: message(error) });
		}
	},

	stop: async () => {
		set({ status: "stopping" });
		const result = await globalThis.electronAPI.stopBrowserRecording();
		if (!result.success) set({ status: "idle" });
	},

	exportTo: async (projectPath, destination) => {
		const { format, name, steps } = get();
		set({ exporting: destination, error: null, outcome: null });
		try {
			const outcome = await globalThis.electronAPI.exportBrowserRecording(projectPath, {
				format,
				destination,
				name,
				stepIds: steps.map((s) => s.id),
			});
			set(outcome.success ? { outcome } : { error: outcome.error ?? null });
		} catch (error) {
			set({ error: message(error) });
		} finally {
			set({ exporting: null });
		}
	},
}));

export function setupBrowserRecorderListeners(): () => void {
	return globalThis.electronAPI.onBrowserRecorderEvent((event) =>
		useBrowserRecorderStore.getState().handleEvent(event),
	);
}
