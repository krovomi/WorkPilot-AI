/**
 * The Browser Agent recorder (#387): the running session, its steps, the
 * format chosen and the last export.
 *
 * Steps arrive from the main process (`setupBrowserRecorderListeners`, once
 * for the window, `global-listeners.ts`). A step the person removed stays
 * removed even if the recorder updates it later (another character typed in
 * the same field). An export sends the ids of the steps kept; the main owns
 * their content.
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

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const useBrowserRecorderStore = create<BrowserRecorderState>((set, get) => ({
	status: "idle",
	steps: [],
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

	handleEvent: (event) => {
		if (event.type === "step") {
			if (get().removed.includes(event.step.id)) return;
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
		set({ status: "starting", steps: [], removed: [], truncated: false, error: null, outcome: null });
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
