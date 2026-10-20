import { create } from "zustand";
import type {
	ContextAwareSnippetResult,
	ContextAwareSnippetsError,
	ContextAwareSnippetsStatus,
	SnippetType,
} from "../../shared/types/context-aware-snippets";

export type {
	ContextAwareSnippetResult,
	ContextAwareSnippetsError,
	ContextAwareSnippetsStatus,
	SnippetType,
} from "../../shared/types/context-aware-snippets";

export type ContextAwareSnippetsPhase =
	| "idle"
	| "generating"
	| "complete"
	| "error";

interface ContextAwareSnippetsState {
	// State
	phase: ContextAwareSnippetsPhase;
	status: ContextAwareSnippetsStatus | "";
	streamingOutput: string;
	result: ContextAwareSnippetResult | null;
	/** Technical detail of the failure (string: read by the activity bridge). */
	error: string | null;
	/** Code of the failure, translated by the dialog. */
	errorCode: string | null;
	isOpen: boolean;
	snippetType: SnippetType;
	description: string;
	language: string;
	autoDetectLanguage: boolean;

	// Actions
	openDialog: (
		snippetType?: SnippetType,
		description?: string,
		language?: string,
	) => void;
	closeDialog: () => void;
	setPhase: (phase: ContextAwareSnippetsPhase) => void;
	setStatus: (status: ContextAwareSnippetsStatus | "") => void;
	appendStreamingOutput: (chunk: string) => void;
	setResult: (result: ContextAwareSnippetResult) => void;
	setError: (error: ContextAwareSnippetsError | string) => void;
	setSnippetType: (snippetType: SnippetType) => void;
	setDescription: (description: string) => void;
	setLanguage: (language: string) => void;
	setAutoDetectLanguage: (autoDetect: boolean) => void;
	reset: () => void;
}

/** The part of the state that belongs to one run, not to the form. */
const runState = {
	phase: "idle" as ContextAwareSnippetsPhase,
	status: "" as ContextAwareSnippetsStatus | "",
	streamingOutput: "",
	result: null,
	error: null,
	errorCode: null,
};

const initialState = {
	...runState,
	isOpen: false,
	snippetType: "component" as SnippetType,
	description: "",
	language: "",
	autoDetectLanguage: true,
};

export const useContextAwareSnippetsStore = create<ContextAwareSnippetsState>(
	(set) => ({
		...initialState,

		/**
		 * Open on a form. A run in flight is never clobbered: the dialog reopens
		 * on it, since the work goes on in the main process whether or not
		 * anyone is looking.
		 */
		openDialog: (snippetType = "component", description = "", language = "") =>
			set((state) =>
				state.phase === "generating"
					? { isOpen: true }
					: {
							...runState,
							isOpen: true,
							snippetType,
							description,
							language,
							autoDetectLanguage: !language,
						},
			),

		/**
		 * Closing hides the dialog; it does not throw the work away. A run keeps
		 * going (the sidebar badge reports it) and a finished snippet is still
		 * there when the dialog is reopened. Only a failed or untouched run is
		 * reset.
		 */
		closeDialog: () =>
			set((state) =>
				state.phase === "generating" || state.phase === "complete"
					? { isOpen: false }
					: { ...runState, isOpen: false },
			),

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
				status: "",
			}),

		setError: (error) =>
			set(
				typeof error === "string"
					? { error, errorCode: "generic", phase: "error", status: "" }
					: {
							error: error.message,
							errorCode: error.code || "generic",
							phase: "error",
							status: "",
						},
			),

		setSnippetType: (snippetType) => set({ snippetType }),

		setDescription: (description) => set({ description }),

		setLanguage: (language) => set({ language }),

		setAutoDetectLanguage: (autoDetect) =>
			set({ autoDetectLanguage: autoDetect }),

		reset: () => set(initialState),
	}),
);

const isGenerating = () =>
	useContextAwareSnippetsStore.getState().phase === "generating";

/**
 * Start snippet generation via IPC.
 *
 * The invoke is awaited: a request the main process refuses (unknown project,
 * no backend, no Python) or that never reaches it (no handler, preload
 * missing) used to leave the spinner turning for ever, because nothing caught
 * the rejection and no error event would ever follow.
 */
export async function startSnippetGeneration(projectId: string): Promise<void> {
	const { snippetType, description, language, autoDetectLanguage } =
		useContextAwareSnippetsStore.getState();

	if (!description.trim()) return;

	useContextAwareSnippetsStore.setState({
		...runState,
		phase: "generating",
		status: "context",
	});

	try {
		const response = await globalThis.electronAPI.generateContextAwareSnippet(
			projectId,
			snippetType,
			description,
			autoDetectLanguage ? undefined : language || undefined,
		);
		if (!response?.success && isGenerating()) {
			useContextAwareSnippetsStore
				.getState()
				.setError(response?.error ?? { code: "generic", message: "" });
		}
	} catch (error) {
		if (isGenerating()) {
			useContextAwareSnippetsStore.getState().setError({
				code: "ipc_failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Stop the running generation and go back to the form, inputs kept.
 */
export function cancelSnippetGeneration(): void {
	if (!isGenerating()) return;
	useContextAwareSnippetsStore.setState({ ...runState });
	// The run is already forgotten here; a failed cancel changes nothing the
	// user can act on.
	try {
		void globalThis.electronAPI
			.cancelSnippetGeneration?.()
			?.catch(() => undefined);
	} catch {
		// No preload (browser preview): nothing is running to cancel.
	}
}

/**
 * Back to the form after a result or a failure, to adjust and generate again.
 */
export function resetSnippetRun(): void {
	if (isGenerating()) return;
	useContextAwareSnippetsStore.setState({ ...runState });
}

/**
 * Setup IPC listeners for context-aware snippets events.
 * Registered once for the life of the window by `global-listeners.ts`.
 * Returns a cleanup function to unsubscribe all listeners.
 */
export function setupContextAwareSnippetsListeners(): () => void {
	const store = () => useContextAwareSnippetsStore.getState();

	// Events of a run the user cancelled can still be in flight.
	const unsubChunk = globalThis.electronAPI.onSnippetStreamChunk(
		(chunk: string) => {
			if (isGenerating()) store().appendStreamingOutput(chunk);
		},
	);

	const unsubStatus = globalThis.electronAPI.onSnippetStatus(
		(status: ContextAwareSnippetsStatus) => {
			if (isGenerating()) store().setStatus(status);
		},
	);

	const unsubError = globalThis.electronAPI.onSnippetError(
		(error: ContextAwareSnippetsError | string) => {
			if (isGenerating()) store().setError(error);
		},
	);

	const unsubComplete = globalThis.electronAPI.onSnippetComplete(
		(result: ContextAwareSnippetResult) => {
			if (isGenerating()) store().setResult(result);
		},
	);

	return () => {
		unsubChunk();
		unsubStatus();
		unsubError();
		unsubComplete();
	};
}

/**
 * Open from the sidebar. A run in flight or a snippet not yet copied is shown
 * again rather than wiped: it is what the sidebar badge pointed at.
 */
export const openContextAwareSnippetsDialog = () => {
	const store = useContextAwareSnippetsStore.getState();
	if (store.phase === "generating" || store.phase === "complete") {
		useContextAwareSnippetsStore.setState({ isOpen: true });
		return;
	}
	store.reset();
	store.openDialog("component", "", "");
};
