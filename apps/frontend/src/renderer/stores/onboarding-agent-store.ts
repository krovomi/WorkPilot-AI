import { create } from "zustand";
import type {
	OnboardingAgentEvent,
	OnboardingAgentResult,
	OnboardingFreshness,
	OnboardingNarration,
	OnboardingPackage,
	OnboardingRole,
	OnboardingText,
} from "../../preload/api/modules/onboarding-agent-api";
import type { OnboardingGuide } from "../../shared/types/onboarding";

export type OnboardingAgentPhase = "idle" | "scanning" | "complete" | "error";

export type OnboardingAgentTab =
	| "overview"
	| "story"
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
	/** Whose tour it is: a frontend tour keeps the UI steps and the general ones. */
	role: OnboardingRole;
	/** "I already know this project": no tour, no quiz, the map stays. */
	skipTour: boolean;
	freshness: OnboardingFreshness | null;
	/** Set when the tour was regenerated because the project's shape changed. */
	regenerated: { added: string[]; removed: string[] } | null;
	narration: OnboardingNarration | null;
	narrating: boolean;
	narrateError: string | null;

	startScan: (projectPath: string) => Promise<void>;
	/** Regenerates the tour when the project's modules changed since the last one. */
	checkFreshness: (projectPath: string) => Promise<void>;
	narrate: (projectPath: string, language: string) => Promise<void>;
	setRole: (role: OnboardingRole) => void;
	setSkipTour: (skip: boolean) => void;
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

const SKIP_TOUR_KEY = "workpilot.onboarding.skipTour";

function readSkipTour(): boolean {
	try {
		return globalThis.localStorage?.getItem(SKIP_TOUR_KEY) === "1";
	} catch {
		return false;
	}
}

function writeSkipTour(skip: boolean): void {
	try {
		globalThis.localStorage?.setItem(SKIP_TOUR_KEY, skip ? "1" : "0");
	} catch {
		// A convenience only: the page works without it.
	}
}

export const useOnboardingAgentStore = create<OnboardingAgentState>((set, get) => ({
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
	role: "fullstack",
	skipTour: readSkipTour(),
	freshness: null,
	regenerated: null,
	narration: null,
	narrating: false,
	narrateError: null,

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
			narration: null,
			narrateError: null,
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
				freshness: result.freshness ?? null,
				regenerated: result.freshness?.changed ?? null,
			});
		} catch (err) {
			set({
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	checkFreshness: async (projectPath) => {
		if (!projectPath || get().phase === "scanning") return;
		let freshness: OnboardingFreshness;
		try {
			freshness = await globalThis.electronAPI.getOnboardingTourStatus({ projectPath });
		} catch {
			return; // the page still offers the scan by hand
		}
		set({ freshness });
		const { pkg, phase } = get();
		if (phase === "scanning") return;
		// A tour was made before: make it again when the shape changed, or when
		// this session has none yet (it is deterministic and costs no model).
		if (freshness.stale || (freshness.known && !pkg)) {
			await get().startScan(projectPath);
		}
	},

	narrate: async (projectPath, language) => {
		if (!projectPath || get().narrating) return;
		set({ narrating: true, narrateError: null });
		try {
			const narration = await globalThis.electronAPI.narrateOnboardingStory({ projectPath, language });
			set({ narration, narrating: false });
		} catch (err) {
			set({ narrating: false, narrateError: err instanceof Error ? err.message : String(err) });
		}
	},

	setRole: (role) => set({ role, currentTourStep: 0 }),
	setSkipTour: (skipTour) => {
		writeSkipTour(skipTour);
		const tab = get().activeTab;
		set({ skipTour, activeTab: skipTour && (tab === "tour" || tab === "quiz") ? "architecture" : tab });
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
			freshness: null,
			regenerated: null,
			narration: null,
			narrating: false,
			narrateError: null,
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
