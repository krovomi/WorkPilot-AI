import { create } from "zustand";
import type {
	OnboardingAgentEvent,
	OnboardingAgentResult,
	OnboardingPackage,
	OnboardingText,
} from "../../preload/api/modules/onboarding-agent-api";
import type { OnboardingGuide } from "../../shared/types/onboarding";

export type OnboardingAgentPhase = "idle" | "scanning" | "complete" | "error";

export type OnboardingAgentTab =
	| "overview"
	| "tour"
	| "architecture"
	| "quiz"
	| "tasks"
	| "glossary";

interface OnboardingAgentState {
	phase: OnboardingAgentPhase;
	status: string;
	guide: OnboardingGuide | null;
	pkg: OnboardingPackage | null;
	activeTab: OnboardingAgentTab;
	currentTourStep: number;
	/** Tour steps the reader ticked off, by ``order``. */
	completedTourSteps: number[];
	quizAnswers: Record<number, number>;
	/** The runner's progress line, as a descriptor the view translates. */
	statusI18n: OnboardingText | null;
	error: string | null;
	/** An i18n key for an error the app raised itself, rather than the runner. */
	errorKey: string | null;

	startScan: (projectPath: string) => Promise<void>;
	cancelScan: () => Promise<void>;
	setStatus: (status: string, statusI18n?: OnboardingText | null) => void;
	setResult: (result: OnboardingAgentResult) => void;
	setError: (error: string) => void;
	setActiveTab: (tab: OnboardingAgentTab) => void;
	setCurrentTourStep: (idx: number) => void;
	toggleTourStepDone: (order: number) => void;
	answerQuiz: (qIdx: number, choice: number) => void;
	resetQuiz: () => void;
	reset: () => void;
}

export const useOnboardingAgentStore = create<OnboardingAgentState>((set) => ({
	phase: "idle",
	status: "",
	guide: null,
	pkg: null,
	activeTab: "overview",
	currentTourStep: 0,
	completedTourSteps: [],
	quizAnswers: {},
	statusI18n: null,
	error: null,
	errorKey: null,

	startScan: async (projectPath) => {
		if (!projectPath) {
			set({ phase: "error", error: null, errorKey: "errors.noProject" });
			return;
		}
		set({
			phase: "scanning",
			status: "",
			statusI18n: null,
			guide: null,
			pkg: null,
			activeTab: "overview",
			currentTourStep: 0,
			completedTourSteps: [],
			quizAnswers: {},
			error: null,
			errorKey: null,
		});
		try {
			const result = await globalThis.electronAPI.runOnboardingAgentScan({
				projectPath,
			});
			set({
				phase: "complete",
				guide: result.guide,
				pkg: result.package ?? null,
				status: "",
			});
		} catch (err) {
			set({
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	cancelScan: async () => {
		await globalThis.electronAPI.cancelOnboardingAgentScan();
		set({ phase: "idle", status: "" });
	},

	setStatus: (status, statusI18n = null) => set({ status, statusI18n }),
	setResult: (result) =>
		set({
			guide: result.guide,
			pkg: result.package ?? null,
			phase: "complete",
		}),
	setError: (error) => set({ error, errorKey: null, phase: "error" }),
	setActiveTab: (tab) => set({ activeTab: tab }),
	setCurrentTourStep: (idx) => set({ currentTourStep: idx }),
	toggleTourStepDone: (order) =>
		set((s) => ({
			completedTourSteps: s.completedTourSteps.includes(order)
				? s.completedTourSteps.filter((o) => o !== order)
				: [...s.completedTourSteps, order],
		})),
	answerQuiz: (qIdx, choice) =>
		set((s) => ({ quizAnswers: { ...s.quizAnswers, [qIdx]: choice } })),
	resetQuiz: () => set({ quizAnswers: {} }),
	reset: () =>
		set({
			phase: "idle",
			status: "",
			guide: null,
			pkg: null,
			activeTab: "overview",
			currentTourStep: 0,
			completedTourSteps: [],
			quizAnswers: {},
			statusI18n: null,
			error: null,
			errorKey: null,
		}),
}));

export function setupOnboardingAgentListeners(): () => void {
	const store = () => useOnboardingAgentStore.getState();

	const unsubEvent = globalThis.electronAPI.onOnboardingAgentEvent(
		(event: OnboardingAgentEvent) => {
			if (event?.data?.status) {
				store().setStatus(event.data.status, event.data.statusI18n ?? null);
			}
		},
	);

	const unsubResult = globalThis.electronAPI.onOnboardingAgentResult(
		(result: OnboardingAgentResult) => {
			store().setResult(result);
		},
	);

	const unsubError = globalThis.electronAPI.onOnboardingAgentError(
		(error: string) => {
			store().setError(error);
		},
	);

	return () => {
		unsubEvent();
		unsubResult();
		unsubError();
	};
}
