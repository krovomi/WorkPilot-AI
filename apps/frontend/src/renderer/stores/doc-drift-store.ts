import { create } from "zustand";
import type { DocDriftEvent } from "../../preload/api/modules/doc-drift-api";
import type { DocDriftFixOutcome, DriftReport } from "../../shared/types/doc-drift";

export type DocDriftPhase = "idle" | "scanning" | "complete" | "error";

interface DocDriftState {
	phase: DocDriftPhase;
	status: string;
	report: DriftReport | null;
	error: string | null;
	/** Fix ids ticked on the page (#354). */
	selectedFixes: string[];
	fixing: boolean;
	fixOutcome: DocDriftFixOutcome | null;
	fixError: string | null;

	toggleFix: (fixId: string) => void;
	selectFixes: (fixIds: string[]) => void;
	applyFixes: (projectPath: string) => Promise<void>;
	startScan: (projectPath: string) => Promise<void>;
	cancelScan: () => Promise<void>;
	setStatus: (status: string) => void;
	setReport: (report: DriftReport) => void;
	setError: (error: string) => void;
	reset: () => void;
}

export const useDocDriftStore = create<DocDriftState>((set, get) => ({
	phase: "idle",
	status: "",
	report: null,
	error: null,
	selectedFixes: [],
	fixing: false,
	fixOutcome: null,
	fixError: null,

	toggleFix: (fixId) => {
		const selected = get().selectedFixes;
		set({
			selectedFixes: selected.includes(fixId) ? selected.filter((id) => id !== fixId) : [...selected, fixId],
		});
	},

	selectFixes: (fixIds) => set({ selectedFixes: [...new Set(fixIds)] }),

	applyFixes: async (projectPath) => {
		const fixIds = get().selectedFixes;
		if (!projectPath || fixIds.length === 0) return;
		set({ fixing: true, fixError: null, fixOutcome: null });
		try {
			const fixOutcome = await globalThis.electronAPI.fixDocDrift({ projectPath, fixIds });
			set({ fixing: false, fixOutcome, selectedFixes: [] });
		} catch (err) {
			set({ fixing: false, fixError: err instanceof Error ? err.message : String(err) });
		}
	},

	startScan: async (projectPath) => {
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
			const report = await globalThis.electronAPI.runDocDriftScan({ projectPath });
			set({ phase: "complete", report, status: "" });
		} catch (err) {
			set({
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	cancelScan: async () => {
		await globalThis.electronAPI.cancelDocDriftScan();
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
			selectedFixes: [],
			fixOutcome: null,
			fixError: null,
		}),
}));

export function setupDocDriftListeners(): () => void {
	const store = () => useDocDriftStore.getState();

	const unsubEvent = globalThis.electronAPI.onDocDriftEvent(
		(event: DocDriftEvent) => {
			if (event?.data?.status) store().setStatus(event.data.status);
		},
	);

	const unsubResult = globalThis.electronAPI.onDocDriftResult(
		(report: DriftReport) => {
			store().setReport(report);
		},
	);

	const unsubError = globalThis.electronAPI.onDocDriftError((error: string) => {
		store().setError(error);
	});

	return () => {
		unsubEvent();
		unsubResult();
		unsubError();
	};
}
