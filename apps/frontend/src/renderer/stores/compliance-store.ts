import { create } from "zustand";
import type { ComplianceEvent } from "../../preload/api/modules/compliance-api";
import type {
	ComplianceConfig,
	ComplianceFrameworks,
	ComplianceReport,
	ComplianceReportListing,
} from "../../shared/types/compliance";

export type CompliancePhase = "idle" | "scanning" | "complete" | "error";

interface ComplianceState {
	phase: CompliancePhase;
	status: string;
	report: ComplianceReport | null;
	error: string | null;
	/** The framework id (soc2, iso27001, hipaa, pci_dss, or a project's own). */
	framework: string;
	/** YYYY-MM; empty for this month to date. */
	period: string;
	catalog: ComplianceFrameworks | null;
	reports: ComplianceReportListing[];
	savingConfig: boolean;

	setFramework: (framework: string) => void;
	setPeriod: (period: string) => void;
	loadCatalog: (projectPath: string) => Promise<void>;
	startScan: (projectPath: string, save?: boolean) => Promise<void>;
	openReport: (projectPath: string, name: string) => Promise<void>;
	setMonthly: (projectPath: string, on: boolean) => Promise<void>;
	cancelScan: () => Promise<void>;
	setStatus: (status: string) => void;
	reset: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const useComplianceStore = create<ComplianceState>((set, get) => ({
	phase: "idle",
	status: "",
	report: null,
	error: null,
	framework: "soc2",
	period: "",
	catalog: null,
	reports: [],
	savingConfig: false,

	setFramework: (framework) => set({ framework }),
	setPeriod: (period) => set({ period }),

	loadCatalog: async (projectPath) => {
		try {
			const [catalog, listed] = await Promise.all([
				globalThis.electronAPI.getComplianceFrameworks(projectPath),
				globalThis.electronAPI.listComplianceReports(projectPath),
			]);
			const known = catalog.frameworks.map((f) => f.id);
			set((s) => ({
				catalog,
				reports: listed.reports,
				framework: known.includes(s.framework) ? s.framework : (known[0] ?? s.framework),
			}));
		} catch (err) {
			set({ catalog: null, reports: [], error: message(err) });
		}
	},

	startScan: async (projectPath, save = false) => {
		if (!projectPath) {
			set({ phase: "error", error: "No project selected" });
			return;
		}
		set({ phase: "scanning", status: "", report: null, error: null });
		try {
			const { framework, period } = get();
			const report = await globalThis.electronAPI.runComplianceScan({
				projectPath,
				framework,
				period: period || undefined,
				save,
			});
			set({ phase: "complete", report, status: "" });
			if (save) {
				const listed = await globalThis.electronAPI.listComplianceReports(projectPath);
				set({ reports: listed.reports });
			}
		} catch (err) {
			set({ phase: "error", error: message(err) });
		}
	},

	openReport: async (projectPath, name) => {
		set({ phase: "scanning", status: "", error: null });
		try {
			const report = await globalThis.electronAPI.loadComplianceReport(projectPath, name);
			set({ phase: "complete", report, framework: report.framework.id, period: report.period.label });
		} catch (err) {
			set({ phase: "error", error: message(err) });
		}
	},

	setMonthly: async (projectPath, on) => {
		const { catalog, framework } = get();
		const current: ComplianceConfig = catalog?.config ?? { frameworks: [], monthly: false };
		const others = current.frameworks.filter((f) => f !== framework);
		const frameworks = on ? [...others, framework] : others;
		set({ savingConfig: true, error: null });
		try {
			const { config } = await globalThis.electronAPI.saveComplianceConfig(projectPath, {
				frameworks,
				monthly: frameworks.length > 0,
			});
			set((s) => ({ catalog: s.catalog ? { ...s.catalog, config } : s.catalog }));
		} catch (err) {
			set({ error: message(err) });
		} finally {
			set({ savingConfig: false });
		}
	},

	cancelScan: async () => {
		await globalThis.electronAPI.cancelComplianceScan();
		set({ phase: "idle", status: "" });
	},

	setStatus: (status) => set({ status }),
	reset: () => set({ phase: "idle", status: "", report: null, error: null }),
}));

export function setupComplianceListeners(): () => void {
	return globalThis.electronAPI.onComplianceEvent((event: ComplianceEvent) => {
		if (event?.data?.status) useComplianceStore.getState().setStatus(event.data.status);
	});
}
