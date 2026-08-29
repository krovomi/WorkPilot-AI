import { create } from "zustand";
import type {
	SmartEstimationEvent,
	SmartEstimationResult,
} from "../../shared/types/smart-estimation";

export type { SmartEstimationResult };

export type SmartEstimationPhase = "idle" | "analyzing" | "complete" | "error";

interface SmartEstimationState {
	// State
	phase: SmartEstimationPhase;
	status: string;
	streamingOutput: string;
	result: SmartEstimationResult | null;
	error: string | null;
	isOpen: boolean;
	initialTaskDescription: string;
	/** Task the dialog was opened from, when it was opened from a card. */
	sourceTaskId: string | null;

	// Actions
	openDialog: (taskDescription: string, sourceTaskId?: string) => void;
	closeDialog: () => void;
	setPhase: (phase: SmartEstimationPhase) => void;
	setStatus: (status: string) => void;
	appendStreamingOutput: (chunk: string) => void;
	setResult: (result: SmartEstimationResult) => void;
	setError: (error: string) => void;
	reset: () => void;
}

const initialState = {
	phase: "idle" as SmartEstimationPhase,
	status: "",
	streamingOutput: "",
	result: null,
	error: null as string | null,
	isOpen: false,
	initialTaskDescription: "",
	sourceTaskId: null as string | null,
};

export const useSmartEstimationStore = create<SmartEstimationState>((set) => ({
	...initialState,

	openDialog: (taskDescription, sourceTaskId) =>
		set({
			isOpen: true,
			initialTaskDescription: taskDescription,
			sourceTaskId: sourceTaskId ?? null,
			phase: "idle",
			status: "",
			streamingOutput: "",
			result: null,
			error: null,
		}),

	closeDialog: () =>
		set({
			isOpen: false,
			sourceTaskId: null,
			phase: "idle",
			status: "",
			streamingOutput: "",
			result: null,
			error: null,
		}),

	setPhase: (phase) => set({ phase }),

	setStatus: (status) => set({ status }),

	appendStreamingOutput: (chunk) =>
		set((state) => ({
			streamingOutput: state.streamingOutput + chunk,
		})),

	setResult: (result) =>
		set({
			result,
			phase: "complete",
		}),

	setError: (error) =>
		set({
			error,
			phase: "error",
		}),

	reset: () => set(initialState),
}));

/**
 * Open the estimation dialog for a task, outside React.
 *
 * Same shape as `openAppEmulatorDialog` / `openLearningLoopDialog`: callers
 * live inside memoized card sub-components where adding a hook would widen
 * the render surface for no gain.
 */
export function openSmartEstimation(
	taskDescription: string,
	sourceTaskId?: string,
): void {
	useSmartEstimationStore.getState().openDialog(taskDescription, sourceTaskId);
}

/**
 * Start smart estimation via IPC
 */
export function startSmartEstimation(projectId: string): void {
	const store = useSmartEstimationStore.getState();
	const { initialTaskDescription } = store;

	if (!projectId || !initialTaskDescription.trim()) return;

	// Reset streaming state
	store.setPhase("analyzing");
	store.setStatus("");
	store.appendStreamingOutput(""); // Clear by setting fresh state
	useSmartEstimationStore.setState({
		streamingOutput: "",
		error: null,
		result: null,
	});

	// The handler rejects when the project or the runner cannot be resolved;
	// surface it instead of leaving the dialog spinning forever.
	globalThis.electronAPI
		.runSmartEstimation(projectId, initialTaskDescription)
		.catch((err: unknown) => {
			useSmartEstimationStore
				.getState()
				.setError(err instanceof Error ? err.message : String(err));
		});
}

/**
 * Setup IPC listeners for smart estimation events.
 * Call this once when the app initializes.
 * Returns a cleanup function to unsubscribe all listeners.
 */
export function setupSmartEstimationListeners(): () => void {
	const store = () => useSmartEstimationStore.getState();

	// Progress events carry the human-readable step in `data.status`, and are
	// also echoed into the streaming pane so a long run shows something.
	const unsubEvent = globalThis.electronAPI.onSmartEstimationEvent(
		(event: SmartEstimationEvent) => {
			const status = event.data?.status;
			if (typeof status === "string" && status.length > 0) {
				store().setStatus(status);
				store().appendStreamingOutput(`${status}\n`);
			}
			if (event.type === "error" && typeof event.data?.error === "string") {
				store().setError(event.data.error);
			}
		},
	);

	const unsubError = globalThis.electronAPI.onSmartEstimationError(
		(error: string) => {
			store().setError(error);
		},
	);

	const unsubComplete = globalThis.electronAPI.onSmartEstimationComplete(
		(result: SmartEstimationResult) => {
			store().setResult(result);
		},
	);

	return () => {
		unsubEvent();
		unsubError();
		unsubComplete();
	};
}
