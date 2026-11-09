import { create } from "zustand";
import type { AccessibilityEvent } from "../../preload/api/modules/accessibility-api";
import type {
	A11yDynamicReport,
	A11yFixOutcome,
	A11yReport,
} from "../../shared/types/accessibility";

export type AccessibilityPhase = "idle" | "scanning" | "complete" | "error";

export type WcagTargetLevel = "A" | "AA" | "AAA";

interface AccessibilityState {
	phase: AccessibilityPhase;
	status: string;
	report: A11yReport | null;
	error: string | null;
	targetLevel: WcagTargetLevel;

	/** The running app's scan (#391). */
	dynamicRunning: boolean;
	dynamicReport: A11yDynamicReport | null;
	dynamicError: string | null;

	/** The fixes ticked for the next review branch, by fix id. */
	selectedFixes: string[];
	fixing: boolean;
	fixOutcome: A11yFixOutcome | null;
	fixError: string | null;

	setTargetLevel: (level: WcagTargetLevel) => void;
	startScan: (projectPath: string, pageLang?: string) => Promise<void>;
	startDynamicScan: (url?: string) => Promise<void>;
	toggleFix: (fixId: string) => void;
	selectFixes: (fixIds: string[]) => void;
	applyFixes: (projectPath: string, pageLang: string, aiAlt: boolean) => Promise<void>;
	cancelScan: () => Promise<void>;
	setStatus: (status: string) => void;
	setReport: (report: A11yReport) => void;
	setError: (error: string) => void;
	reset: () => void;
}

export const useAccessibilityStore = create<AccessibilityState>((set, get) => ({
	phase: "idle",
	status: "",
	report: null,
	error: null,
	targetLevel: "AA",
	dynamicRunning: false,
	dynamicReport: null,
	dynamicError: null,
	selectedFixes: [],
	fixing: false,
	fixOutcome: null,
	fixError: null,

	setTargetLevel: (level) => set({ targetLevel: level }),

	startDynamicScan: async (url) => {
		set({ dynamicRunning: true, dynamicError: null });
		try {
			const dynamicReport = await globalThis.electronAPI.runAccessibilityDynamicScan({
				url: url?.trim() || undefined,
				targetLevel: get().targetLevel,
			});
			set({ dynamicRunning: false, dynamicReport });
		} catch (err) {
			set({ dynamicRunning: false, dynamicError: err instanceof Error ? err.message : String(err) });
		}
	},

	toggleFix: (fixId) =>
		set((state) => ({
			selectedFixes: state.selectedFixes.includes(fixId)
				? state.selectedFixes.filter((id) => id !== fixId)
				: [...state.selectedFixes, fixId],
		})),

	selectFixes: (fixIds) => set({ selectedFixes: [...new Set(fixIds)] }),

	applyFixes: async (projectPath, pageLang, aiAlt) => {
		const fixIds = get().selectedFixes;
		if (!projectPath || fixIds.length === 0) return;
		set({ fixing: true, fixError: null, fixOutcome: null });
		try {
			const fixOutcome = await globalThis.electronAPI.fixAccessibilityViolations({
				projectPath,
				fixIds,
				pageLang,
				aiAlt,
			});
			set({ fixing: false, fixOutcome, selectedFixes: [] });
		} catch (err) {
			set({ fixing: false, fixError: err instanceof Error ? err.message : String(err) });
		}
	},

	startScan: async (projectPath, pageLang) => {
		if (!projectPath) {
			set({ phase: "error", error: "No project selected" });
			return;
		}
		set({
			phase: "scanning",
			status: "Starting scan...",
			report: null,
			error: null,
			selectedFixes: [],
			fixOutcome: null,
			fixError: null,
		});
		try {
			const report = await globalThis.electronAPI.runAccessibilityScan({
				projectPath,
				targetLevel: get().targetLevel,
				pageLang,
			});
			set({ phase: "complete", report, status: "" });
		} catch (err) {
			set({
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	cancelScan: async () => {
		await globalThis.electronAPI.cancelAccessibilityScan();
		set({ phase: "idle", status: "" });
	},

	setStatus: (status) => set({ status }),
	setReport: (report) => set({ report, phase: "complete" }),
	setError: (error) => set({ error, phase: "error" }),
	reset: () =>
		set({
			phase: "idle",
			status: "",
			report: null,
			error: null,
			dynamicReport: null,
			dynamicError: null,
			selectedFixes: [],
			fixOutcome: null,
			fixError: null,
		}),
}));

/**
 * Subscribe the store to runner events. Call once at app startup.
 * Returns a cleanup function.
 */
export function setupAccessibilityListeners(): () => void {
	const store = () => useAccessibilityStore.getState();

	const unsubEvent = globalThis.electronAPI.onAccessibilityEvent(
		(event: AccessibilityEvent) => {
			if (event?.data?.status) store().setStatus(event.data.status);
		},
	);

	const unsubResult = globalThis.electronAPI.onAccessibilityResult(
		(report: A11yReport) => {
			store().setReport(report);
		},
	);

	const unsubError = globalThis.electronAPI.onAccessibilityError(
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
