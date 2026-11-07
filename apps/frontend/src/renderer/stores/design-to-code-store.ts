import { create } from "zustand";
import {
	DESIGN_STACK_INFO,
	type DesignSourceKind,
	type DesignStack,
	type DesignStackDetection,
	type DesignStyle,
	type DesignToCodeProgress,
	type DesignToCodeResult,
	type DesignWriteOutcome,
} from "../../shared/types/design-to-code";
import { type DesignStep, stepOfPhase } from "../lib/design-import-steps";
import { useProjectStore } from "./project-store";

export type {
	DesignComponentSpec as ComponentSpec,
	DesignGeneratedFile as GeneratedFile,
	DesignSpecSummary as DesignSpec,
	DesignTokenUsed,
	DesignToCodeResult,
	DesignVisualTest as VisualTest,
} from "../../shared/types/design-to-code";

export type PipelinePhase =
	| "idle"
	| "analyzing"
	| "spec_generation"
	| "code_generation"
	| "design_token_integration"
	| "visual_test_generation"
	| "figma_sync"
	| "complete"
	| "error";

export type FrameworkType = DesignStack;
export type DesignSourceType = DesignSourceKind;

/** One line of the run's journal, as the runner reported it. */
export interface DesignJournalEntry {
	phase: string;
	at: number;
}

/** What the page knows before the final result: the live view of the run. */
export interface DesignLiveState {
	spec: NonNullable<DesignToCodeProgress["detail"]["spec"]> | null;
	tokens: number | null;
	tokensSkipped: boolean;
	files: string[];
	testsSupported: boolean | null;
}

const EMPTY_LIVE: DesignLiveState = {
	spec: null,
	tokens: null,
	tokensSkipped: false,
	files: [],
	testsSupported: null,
};

const NOTES_STORAGE_KEY = "design-import-notes";

function loadNotes(): Record<number, string> {
	try {
		const raw = globalThis.localStorage?.getItem(NOTES_STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveNotes(notes: Record<number, string>): void {
	try {
		globalThis.localStorage?.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
	} catch {
		/* private window or blocked storage: the sentence lasts for the session */
	}
}

interface DesignToCodeState {
	// Pipeline state
	phase: PipelinePhase;
	status: string;
	result: DesignToCodeResult | null;
	error: string | null;
	failedStep: DesignStep | null;
	live: DesignLiveState;
	journal: DesignJournalEntry[];
	startedAt: number | null;

	/** The project the page was last opened on. */
	projectId: string | null;

	// Configuration
	framework: FrameworkType;
	style: DesignStyle | null;
	/** The person picked the stack: detection no longer overrides it. */
	stackChosen: boolean;
	detection: DesignStackDetection | null;
	sourceType: DesignSourceType;
	designSystemPath: string;
	figmaUrl: string;
	generateTests: boolean;
	useDesignTokens: boolean;
	customInstructions: string;

	// Image state
	imageData: string | null;
	imagePreview: string | null;
	imageName: string | null;

	// Page state
	selectedStep: DesignStep | null;
	selectedFilePath: string | null;
	/** Sentences the person rewrote between two steps, by gap index. */
	notes: Record<number, string>;
	writing: boolean;
	writeOutcome: DesignWriteOutcome | null;
}

interface DesignToCodeActions {
	setFramework: (framework: FrameworkType) => void;
	setStyle: (style: DesignStyle | null) => void;
	applyDetection: (detection: DesignStackDetection) => void;
	setSourceType: (sourceType: DesignSourceType) => void;
	setDesignSystemPath: (path: string) => void;
	setFigmaUrl: (url: string) => void;
	setGenerateTests: (generate: boolean) => void;
	setUseDesignTokens: (use: boolean) => void;
	setCustomInstructions: (instructions: string) => void;

	setImageData: (
		data: string | null,
		preview: string | null,
		name: string | null,
	) => void;
	clearImage: () => void;

	startPipeline: () => void;
	applyProgress: (progress: DesignToCodeProgress) => void;
	updatePhase: (phase: PipelinePhase, status: string) => void;
	setPipelineResult: (result: DesignToCodeResult) => void;
	setPipelineError: (error: string) => void;
	resetPipeline: () => void;

	selectStep: (step: DesignStep | null) => void;
	selectFile: (path: string | null) => void;
	setNote: (index: number, text: string | null) => void;
	setWriting: (writing: boolean) => void;
	setWriteOutcome: (outcome: DesignWriteOutcome | null) => void;
}

const initialState: DesignToCodeState = {
	phase: "idle",
	status: "",
	result: null,
	error: null,
	failedStep: null,
	live: EMPTY_LIVE,
	journal: [],
	startedAt: null,
	projectId: null,
	framework: "react",
	style: null,
	stackChosen: false,
	detection: null,
	sourceType: "screenshot",
	designSystemPath: "",
	figmaUrl: "",
	generateTests: true,
	useDesignTokens: true,
	customInstructions: "",
	imageData: null,
	imagePreview: null,
	imageName: null,
	selectedStep: null,
	selectedFilePath: null,
	notes: {},
	writing: false,
	writeOutcome: null,
};

export const useDesignToCodeStore = create<
	DesignToCodeState & DesignToCodeActions
>((set, get) => ({
	...initialState,
	notes: loadNotes(),

	setFramework: (framework) =>
		set((s) => ({
			framework,
			stackChosen: true,
			// A web styling choice means nothing to Flutter or XAML.
			style: DESIGN_STACK_INFO[framework].webStyles ? s.style : null,
		})),
	setStyle: (style) => set({ style, stackChosen: true }),
	applyDetection: (detection) =>
		set((s) => {
			const next: Partial<DesignToCodeState> = { detection };
			if (!s.stackChosen && detection.stack) {
				next.framework = detection.stack;
				next.style = detection.style;
			}
			if (!s.designSystemPath && detection.designSystemPath) {
				next.designSystemPath = detection.designSystemPath;
			}
			return next;
		}),
	setSourceType: (sourceType) => set({ sourceType }),
	setDesignSystemPath: (path) => set({ designSystemPath: path }),
	setFigmaUrl: (url) => set({ figmaUrl: url }),
	setGenerateTests: (generate) => set({ generateTests: generate }),
	setUseDesignTokens: (use) => set({ useDesignTokens: use }),
	setCustomInstructions: (instructions) =>
		set({ customInstructions: instructions }),

	setImageData: (data, preview, name) =>
		set({ imageData: data, imagePreview: preview, imageName: name }),
	clearImage: () =>
		set({ imageData: null, imagePreview: null, imageName: null }),

	startPipeline: () =>
		set({
			phase: "analyzing",
			status: "",
			error: null,
			result: null,
			failedStep: null,
			live: EMPTY_LIVE,
			journal: [{ phase: "analyzing", at: Date.now() }],
			startedAt: Date.now(),
			selectedStep: null,
			selectedFilePath: null,
			writeOutcome: null,
		}),
	applyProgress: (progress) =>
		set((s) => {
			if (s.phase === "idle" || s.phase === "complete" || s.phase === "error") {
				return {};
			}
			const detail = progress.detail ?? {};
			const live: DesignLiveState = { ...s.live };
			if (detail.spec) live.spec = detail.spec;
			if (typeof detail.tokens === "number") live.tokens = detail.tokens;
			if (detail.tokens_skipped) live.tokensSkipped = true;
			if (Array.isArray(detail.files)) live.files = detail.files;
			if (typeof detail.tests_supported === "boolean") {
				live.testsSupported = detail.tests_supported;
			}
			const phase = progress.phase as PipelinePhase;
			const journal =
				s.journal.at(-1)?.phase === phase
					? s.journal
					: [...s.journal, { phase, at: Date.now() }];
			// "complete" and "error" come with the final result, not here.
			const nextPhase =
				phase === "complete" || phase === "error" ? s.phase : phase;
			return { live, journal, phase: nextPhase, status: progress.status };
		}),
	updatePhase: (phase, status) => set({ phase, status }),
	setPipelineResult: (result) =>
		set((s) => {
			const firstFile = result.generated_files?.[0]?.path ?? null;
			const failed = !result.success;
			return {
				result,
				phase: failed ? "error" : "complete",
				status: "",
				error: result.errors?.length ? result.errors.join("; ") : null,
				failedStep: failed ? stepOfPhase(s.phase) : null,
				selectedStep: failed ? s.selectedStep : "code",
				selectedFilePath: firstFile,
				journal: [...s.journal, { phase: failed ? "error" : "complete", at: Date.now() }],
			};
		}),
	setPipelineError: (error) =>
		set((s) => ({
			phase: "error",
			status: "",
			error,
			failedStep: stepOfPhase(s.phase) ?? "vision",
			journal: [...s.journal, { phase: "error", at: Date.now() }],
		})),
	resetPipeline: () =>
		set({
			phase: "idle",
			status: "",
			result: null,
			error: null,
			failedStep: null,
			live: EMPTY_LIVE,
			journal: [],
			startedAt: null,
			selectedStep: null,
			selectedFilePath: null,
			writeOutcome: null,
		}),

	selectStep: (step) => set({ selectedStep: step }),
	selectFile: (path) => set({ selectedFilePath: path }),
	setNote: (index, text) => {
		const notes = { ...get().notes };
		if (text?.trim()) notes[index] = text.trim();
		else delete notes[index];
		saveNotes(notes);
		set({ notes });
	},
	setWriting: (writing) => set({ writing }),
	setWriteOutcome: (outcome) => set({ writeOutcome: outcome }),
}));

/**
 * The live steps of a run, registered once for the window
 * (`stores/global-listeners.ts`), never by the page.
 */
export function setupDesignToCodeListeners(): () => void {
	return globalThis.electronAPI.onDesignToCodeProgress((progress) => {
		useDesignToCodeStore.getState().applyProgress(progress);
	});
}

/** Detect the stack of the selected project, unless the person chose one. */
export async function detectDesignStack(projectId: string | null): Promise<void> {
	if (!projectId) return;
	try {
		const detection = await globalThis.electronAPI.detectDesignStack(projectId);
		if (detection) useDesignToCodeStore.getState().applyDetection(detection);
	} catch {
		/* no detection: the person picks the stack */
	}
}

/**
 * Run the design-to-code pipeline via IPC
 */
export async function runDesignToCodePipeline(): Promise<void> {
	const state = useDesignToCodeStore.getState();

	if (!state.imageData && !state.figmaUrl) {
		state.setPipelineError("missing_input");
		return;
	}

	state.startPipeline();

	try {
		const result = await globalThis.electronAPI.runDesignToCodePipeline({
			projectId: useProjectStore.getState().selectedProjectId ?? undefined,
			imageData: state.imageData || "",
			framework: state.framework,
			style: state.style ?? undefined,
			sourceType: state.sourceType,
			designSystemPath: state.designSystemPath,
			figmaUrl: state.figmaUrl,
			generateTests: state.generateTests,
			useDesignTokens: state.useDesignTokens,
			customInstructions: state.customInstructions,
		});

		useDesignToCodeStore.getState().setPipelineResult(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		useDesignToCodeStore.getState().setPipelineError(message);
	}
}

/** Write the generated files and tests into the selected project. */
export async function writeDesignFilesToProject(): Promise<void> {
	const state = useDesignToCodeStore.getState();
	const projectId = useProjectStore.getState().selectedProjectId;
	if (!projectId || !state.result) return;
	const files = [
		...state.result.generated_files.map((f) => ({ path: f.path, content: f.content })),
		...state.result.visual_tests
			.filter((t) => t.path)
			.map((t) => ({ path: t.path as string, content: t.test_code })),
	];
	state.setWriting(true);
	try {
		const outcome = await globalThis.electronAPI.writeDesignFiles(projectId, files);
		useDesignToCodeStore.getState().setWriteOutcome(outcome);
		useDesignToCodeStore.getState().selectStep("project");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		useDesignToCodeStore.setState({ error: message });
	} finally {
		useDesignToCodeStore.getState().setWriting(false);
	}
}
