import { create } from "zustand";
import type {
	ArchifyReadiness,
	ArchitectureBaseline,
	ArchitectureVisualizerResult,
} from "../../main/architecture-visualizer-service";

export type ArchitectureVisualizerPhase =
	| "idle"
	| "checking"
	| "generating"
	| "complete"
	| "error";

interface ArchitectureVisualizerState {
	phase: ArchitectureVisualizerPhase;
	status: string;
	streamingOutput: string;
	/** Whether archify can run here, and what is missing when it cannot. */
	readiness: ArchifyReadiness | null;
	/** The model already on disk. Read at open, so the page is never blank. */
	baseline: ArchitectureBaseline | null;
	/** `file://` URL of the rendered artifact, resolved once it exists. */
	artifactUrl: string | null;
	error: string | null;
	model?: string;
	thinkingLevel?: string;

	setPhase: (phase: ArchitectureVisualizerPhase) => void;
	setStatus: (status: string) => void;
	appendStreamingOutput: (chunk: string) => void;
	setError: (error: string) => void;
	setModel: (model?: string) => void;
	setThinkingLevel: (level?: string) => void;
	reset: () => void;
}

const initialState = {
	phase: "idle" as ArchitectureVisualizerPhase,
	status: "",
	streamingOutput: "",
	readiness: null,
	baseline: null,
	artifactUrl: null,
	error: null,
	model: undefined,
	thinkingLevel: undefined,
};

export const useArchitectureVisualizerStore =
	create<ArchitectureVisualizerState>((set) => ({
		...initialState,

		setPhase: (phase) => set({ phase }),
		setStatus: (status) => set({ status }),
		appendStreamingOutput: (chunk) =>
			set((s) => ({ streamingOutput: s.streamingOutput + chunk })),
		setError: (error) => set({ error, phase: "error" }),
		setModel: (model) => set({ model }),
		setThinkingLevel: (thinkingLevel) => set({ thinkingLevel }),
		reset: () => set(initialState),
	}));

/**
 * Read what is already on disk: the doctor, and the baseline if there is one.
 *
 * The page used to start empty on every open and clear its result on close, so
 * a model generated five minutes earlier was invisible until it was generated
 * again. Nothing read the files back.
 *
 * It runs on every mount, and `App.tsx` mounts the page afresh each time the
 * user navigates back to it — so it must never answer "not running" about a
 * generation that is. It used to set `checking` and then `idle` unconditionally,
 * which is how leaving the page mid-generation and coming back showed an empty
 * page with a Generate button, while the map was still being built in the main
 * process. The service is the authority on that, and it answers in the same
 * round trip.
 */
export async function loadArchitectureState(projectDir: string): Promise<void> {
	const wasGenerating =
		useArchitectureVisualizerStore.getState().phase === "generating";

	if (!wasGenerating) {
		useArchitectureVisualizerStore.setState({
			phase: "checking",
			error: null,
		});
	}

	const result = await window.electronAPI.checkArchifyReadiness(projectDir);
	if (!result.success || !result.data) {
		// A doctor that could not run says nothing about a generation in flight.
		if (!wasGenerating) {
			useArchitectureVisualizerStore.setState({
				phase: "error",
				error: result.error ?? "could not check the archify runtime",
			});
		}
		return;
	}

	const { readiness = null, baseline = null, running = false } = result.data;
	// `running` also recovers a generation across a window reload, where the
	// store starts empty and only the service remembers.
	useArchitectureVisualizerStore.setState({
		readiness,
		baseline,
		phase: running || wasGenerating ? "generating" : "idle",
	});

	if (baseline?.artifact) {
		await resolveArtifact(baseline.artifact);
	}
}

async function resolveArtifact(artifactPath: string): Promise<void> {
	const resolved =
		await window.electronAPI.resolveArchitectureArtifact(artifactPath);
	useArchitectureVisualizerStore.setState({
		artifactUrl: resolved.success ? (resolved.data?.url ?? null) : null,
	});
}

export function generateArchitectureMap(projectDir: string): void {
	const store = useArchitectureVisualizerStore.getState();
	useArchitectureVisualizerStore.setState({
		phase: "generating",
		streamingOutput: "",
		error: null,
	});

	void window.electronAPI.generateArchitectureMap({
		projectDir,
		model: store.model,
		thinkingLevel: store.thinkingLevel,
	});
}

export function cancelArchitectureVisualization(): void {
	void window.electronAPI.cancelArchitectureVisualization();
	useArchitectureVisualizerStore.getState().setPhase("idle");
}

/**
 * Subscribe to the service's events.
 *
 * Registered once for the session by `stores/global-listeners.ts`, never by
 * the page: a generation outlives the view that started it, and a listener
 * torn down on unmount would drop the events it emits in between.
 */
export function setupArchitectureVisualizerListeners(): () => void {
	const store = () => useArchitectureVisualizerStore.getState();

	const unsubChunk = window.electronAPI.onArchitectureVisualizerStreamChunk(
		(chunk: string) => store().appendStreamingOutput(chunk),
	);

	const unsubStatus = window.electronAPI.onArchitectureVisualizerStatus(
		(status: string) => store().setStatus(status),
	);

	const unsubError = window.electronAPI.onArchitectureVisualizerError(
		(error: string) => store().setError(error),
	);

	const unsubComplete = window.electronAPI.onArchitectureVisualizerComplete(
		(result: ArchitectureVisualizerResult) => {
			if (result.action !== "map") return;
			useArchitectureVisualizerStore.setState({
				phase: "complete",
				baseline: {
					path: result.specPath ?? "",
					artifact: result.artifactPath ?? undefined,
					title: result.title,
					components: result.components,
					connections: result.connections,
				},
			});
			if (result.artifactPath) void resolveArtifact(result.artifactPath);
		},
	);

	return () => {
		unsubChunk();
		unsubStatus();
		unsubError();
		unsubComplete();
	};
}
