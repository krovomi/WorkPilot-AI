import { create } from "zustand";
import type { CarbonProfilerEvent } from "../../preload/api/modules/carbon-profiler-api";
import type { CarbonConfigInput, CarbonExportFormat, CarbonReport } from "../../shared/types/carbon-profiler";

export type CarbonProfilerPhase = "idle" | "scanning" | "complete" | "error";

/** The current month, YYYY-MM (UTC, as the budget counts it). */
export function currentMonth(now = new Date()): string {
	return now.toISOString().slice(0, 7);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface CarbonProfilerState {
	phase: CarbonProfilerPhase;
	status: string;
	report: CarbonReport | null;
	error: string | null;
	/** YYYY-MM, or "" for the whole ledger. */
	month: string;
	saving: boolean;
	exported: string | null;

	setMonth: (month: string) => void;
	startScan: (projectPath: string, options?: { backfill?: boolean; month?: string }) => Promise<void>;
	cancelScan: () => Promise<void>;
	saveConfig: (projectPath: string, config: CarbonConfigInput) => Promise<boolean>;
	exportReport: (projectPath: string, format: CarbonExportFormat) => Promise<void>;
	setStatus: (status: string) => void;
	reset: () => void;
}

export const useCarbonProfilerStore = create<CarbonProfilerState>((set, get) => ({
	phase: "idle",
	status: "",
	report: null,
	error: null,
	month: currentMonth(),
	saving: false,
	exported: null,

	setMonth: (month) => set({ month }),

	startScan: async (projectPath, options) => {
		if (!projectPath) {
			set({ phase: "error", error: "No project selected" });
			return;
		}
		set({ phase: "scanning", status: "", error: null, exported: null });
		try {
			const report = await globalThis.electronAPI.runCarbonProfilerScan({
				projectPath,
				month: options?.month ?? get().month,
				backfill: options?.backfill === true,
			});
			set({ phase: "complete", report, status: "" });
		} catch (err) {
			set({ phase: "error", error: message(err) });
		}
	},

	cancelScan: async () => {
		await globalThis.electronAPI.cancelCarbonProfilerScan();
		set({ phase: get().report ? "complete" : "idle", status: "" });
	},

	saveConfig: async (projectPath, config) => {
		set({ saving: true, error: null });
		try {
			await globalThis.electronAPI.saveCarbonConfig(projectPath, config);
			set({ saving: false });
			await get().startScan(projectPath);
			return true;
		} catch (err) {
			set({ saving: false, phase: "error", error: message(err) });
			return false;
		}
	},

	exportReport: async (projectPath, format) => {
		const month = get().month || currentMonth();
		try {
			const file = await globalThis.electronAPI.exportCarbonReport(projectPath, month, format);
			set({ exported: file });
		} catch (err) {
			set({ phase: "error", error: message(err) });
		}
	},

	setStatus: (status) => set({ status }),
	reset: () => set({ phase: "idle", status: "", report: null, error: null, exported: null }),
}));

export function setupCarbonProfilerListeners(): () => void {
	return globalThis.electronAPI.onCarbonProfilerEvent((event: CarbonProfilerEvent) => {
		if (event?.data?.status) useCarbonProfilerStore.getState().setStatus(event.data.status);
	});
}
