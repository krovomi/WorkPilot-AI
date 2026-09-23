import { create } from "zustand";
import type {
	PromptOptimizerAgentType,
	PromptOptimizerError,
	PromptOptimizerResult,
	PromptOptimizerStatus,
} from "../../shared/types/prompt-optimizer";

export type {
	PromptOptimizerError,
	PromptOptimizerResult,
	PromptOptimizerStatus,
} from "../../shared/types/prompt-optimizer";

export type AgentType = PromptOptimizerAgentType;

export type PromptOptimizerPhase = "idle" | "optimizing" | "complete" | "error";

/** Where "Use this prompt" sends the result — the field that opened the dialog. */
export type ApplyPromptTarget = (optimizedPrompt: string) => void;

interface PromptOptimizerState {
	// State
	phase: PromptOptimizerPhase;
	status: PromptOptimizerStatus | "";
	streamingOutput: string;
	result: PromptOptimizerResult | null;
	/** Technical detail of the failure (string: read by the activity bridge). */
	error: string | null;
	/** Code of the failure, translated by the dialog. */
	errorCode: string | null;
	isOpen: boolean;
	initialPrompt: string;
	/** The prompt the running / finished optimization was started from. */
	submittedPrompt: string;
	agentType: AgentType;
	applyTarget: ApplyPromptTarget | null;

	// Actions
	openDialog: (
		prompt: string,
		agentType?: AgentType,
		applyTarget?: ApplyPromptTarget,
	) => void;
	closeDialog: () => void;
	setPhase: (phase: PromptOptimizerPhase) => void;
	setStatus: (status: PromptOptimizerStatus | "") => void;
	appendStreamingOutput: (chunk: string) => void;
	setResult: (result: PromptOptimizerResult) => void;
	setError: (error: PromptOptimizerError | string) => void;
	setAgentType: (agentType: AgentType) => void;
	reset: () => void;
}

const initialState = {
	phase: "idle" as PromptOptimizerPhase,
	status: "" as PromptOptimizerStatus | "",
	streamingOutput: "",
	result: null,
	error: null,
	errorCode: null,
	isOpen: false,
	initialPrompt: "",
	submittedPrompt: "",
	agentType: "general" as AgentType,
	applyTarget: null,
};

const runState = {
	phase: "idle" as PromptOptimizerPhase,
	status: "" as PromptOptimizerStatus | "",
	streamingOutput: "",
	result: null,
	error: null,
	errorCode: null,
};

export const usePromptOptimizerStore = create<PromptOptimizerState>((set) => ({
	...initialState,

	/**
	 * Open on a prompt. A run in flight is never clobbered: the dialog reopens
	 * on it, since the work goes on in the main process whether or not anyone
	 * is looking.
	 */
	openDialog: (prompt, agentType = "general", applyTarget) =>
		set((state) =>
			state.phase === "optimizing"
				? { isOpen: true, applyTarget: applyTarget ?? state.applyTarget }
				: {
						...runState,
						isOpen: true,
						initialPrompt: prompt,
						submittedPrompt: "",
						agentType,
						applyTarget: applyTarget ?? null,
					},
		),

	/**
	 * Closing hides the dialog; it does not throw the work away. A run keeps
	 * going (the sidebar badge reports it) and a finished result is still there
	 * when the dialog is reopened. Only a failed or untouched dialog is reset.
	 */
	closeDialog: () =>
		set((state) =>
			state.phase === "optimizing" || state.phase === "complete"
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

	setAgentType: (agentType) => set({ agentType }),

	reset: () => set(initialState),
}));

/**
 * Start prompt optimization via IPC
 */
export function startOptimization(projectId: string): void {
	const { initialPrompt, agentType } = usePromptOptimizerStore.getState();

	if (!initialPrompt.trim()) return;

	usePromptOptimizerStore.setState({
		...runState,
		phase: "optimizing",
		status: "context",
		submittedPrompt: initialPrompt,
	});

	globalThis.electronAPI.optimizePrompt(projectId, initialPrompt, agentType);
}

/**
 * Stop the running optimization and go back to editing the prompt.
 */
export function cancelOptimization(): void {
	if (usePromptOptimizerStore.getState().phase !== "optimizing") return;
	globalThis.electronAPI.cancelPromptOptimization?.();
	usePromptOptimizerStore.setState({ ...runState });
}

/**
 * Take the optimized prompt as the new input, to optimize it again or edit it.
 */
export function refineFromResult(): void {
	const { result } = usePromptOptimizerStore.getState();
	if (!result) return;
	usePromptOptimizerStore.setState({
		...runState,
		initialPrompt: result.optimized,
	});
}

/**
 * The part of the streamed answer that is the optimized prompt, as it forms.
 *
 * The runner asks for `<optimized_prompt>…</optimized_prompt>` first, so the
 * text after the opening tag is the prompt being written. Before the tag
 * arrives there is nothing to show; a model that ignores the tags gets its raw
 * text shown instead of nothing.
 */
export function extractStreamingPrompt(stream: string): string {
	const open = stream.search(/<optimized_prompt>/i);
	if (open < 0) {
		const head = stream.trim();
		// The opening tag itself, still arriving.
		if ("<optimized_prompt>".startsWith(head.toLowerCase())) return "";
		return /<(changes|reasoning)>/i.test(stream) ? "" : head;
	}
	const rest = stream.slice(open + "<optimized_prompt>".length);
	const close = rest.search(/<\/optimized_prompt>|<changes>|<reasoning>/i);
	const body = close >= 0 ? rest.slice(0, close) : rest;
	// Hide a closing tag that is still arriving character by character.
	return body.replace(/<\/?[a-z_]*$/i, "").trim();
}

/**
 * Setup IPC listeners for prompt optimizer events.
 * Registered once for the life of the window by `global-listeners.ts`.
 * Returns a cleanup function to unsubscribe all listeners.
 */
export function setupPromptOptimizerListeners(): () => void {
	const store = () => usePromptOptimizerStore.getState();
	// Events of a run the user cancelled can still be in flight.
	const isRunning = () => store().phase === "optimizing";

	const unsubChunk = globalThis.electronAPI.onPromptOptimizerStreamChunk(
		(chunk: string) => {
			if (isRunning()) store().appendStreamingOutput(chunk);
		},
	);

	const unsubStatus = globalThis.electronAPI.onPromptOptimizerStatus(
		(status: PromptOptimizerStatus) => {
			if (isRunning()) store().setStatus(status);
		},
	);

	const unsubError = globalThis.electronAPI.onPromptOptimizerError(
		(error: PromptOptimizerError | string) => {
			if (isRunning()) store().setError(error);
		},
	);

	const unsubComplete = globalThis.electronAPI.onPromptOptimizerComplete(
		(result: PromptOptimizerResult) => {
			if (isRunning()) store().setResult(result);
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
 * Open from the sidebar. A run in flight or a result not yet used is shown
 * again rather than wiped: it is what the sidebar badge pointed at.
 */
export const openPromptOptimizerDialog = () => {
	const store = usePromptOptimizerStore.getState();
	if (store.phase === "optimizing" || store.phase === "complete") {
		usePromptOptimizerStore.setState({ isOpen: true, applyTarget: null });
		return;
	}
	store.reset();
	store.openDialog("", "general");
};
