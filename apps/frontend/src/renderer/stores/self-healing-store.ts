/**
 * Self-Healing Codebase + Incident Responder Store
 *
 * Feature #3 (Tier S+) - Zustand store for managing self-healing state.
 */

import type {
	BisectProgressEvent,
	BisectResult,
	BisectStep,
	CICDConfig,
	FragilityReport,
	HealingOperation,
	Incident,
	IncidentCluster,
	IncidentMode,
	ProactiveConfig,
	ProductionConfig,
	RiskTrendReport,
	SelfHealingDashboardData,
	SelfHealingStats,
} from "@shared/types/self-healing";
import { create } from "zustand";
import { persist } from "zustand/middleware";

// ── Store State ─────────────────────────────────────────────

/** One incident's bisect, as the view shows it while it runs and after. */
export interface BisectRun {
	running: boolean;
	steps: Array<BisectStep & { tested: number }>;
	result?: BisectResult;
	error?: string;
}

interface SelfHealingState {
	// Data
	incidents: Incident[];
	activeOperations: HealingOperation[];
	fragilityReports: FragilityReport[];
	stats: SelfHealingStats;
	riskTrends: RiskTrendReport | null;
	incidentClusters: IncidentCluster[];
	bisects: Record<string, BisectRun>;

	// Configuration
	cicdConfig: CICDConfig;
	productionConfig: ProductionConfig;
	proactiveConfig: ProactiveConfig;

	// UI State
	activeTab: IncidentMode;
	isLoading: boolean;
	isScanning: boolean;
	error: string | null;

	// Actions
	setActiveTab: (tab: IncidentMode) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	setDashboardData: (data: SelfHealingDashboardData) => void;
	setIncidents: (incidents: Incident[]) => void;
	setFragilityReports: (reports: FragilityReport[]) => void;
	setActiveOperations: (operations: HealingOperation[]) => void;
	setCICDConfig: (projectPath: string, config: Partial<CICDConfig>) => void;
	setProductionConfig: (
		projectPath: string,
		config: Partial<ProductionConfig>,
	) => void;
	setProactiveConfig: (
		projectPath: string,
		config: Partial<ProactiveConfig>,
	) => void;
	setScanning: (scanning: boolean) => void;

	// Async actions
	fetchDashboard: (projectPath: string) => Promise<void>;
	triggerProactiveScan: (projectPath: string) => Promise<void>;
	triggerFix: (projectPath: string, incidentId: string) => Promise<void>;
	dismissIncident: (projectPath: string, incidentId: string) => Promise<void>;
	retryIncident: (projectPath: string, incidentId: string) => Promise<void>;
	startBisect: (
		projectPath: string,
		incidentId: string,
		goodSha?: string,
	) => Promise<void>;
	applyBisectProgress: (event: BisectProgressEvent) => void;
}

// ── Default Values ──────────────────────────────────────────

const defaultStats: SelfHealingStats = {
	totalIncidents: 0,
	resolvedIncidents: 0,
	activeIncidents: 0,
	avgResolutionTime: 0,
	autoFixRate: 0,
};

const defaultCICDConfig: CICDConfig = {
	enabled: false,
	watchBranches: ["main", "develop"],
	autoFixEnabled: true,
};

const defaultProductionConfig: ProductionConfig = {
	enabled: false,
	connectedSources: [],
	autoAnalyze: true,
	autoFix: false,
	severityThreshold: "high",
};

const defaultProactiveConfig: ProactiveConfig = {
	enabled: false,
	scanFrequency: "weekly",
	riskThreshold: 40,
	autoGenerateTests: false,
};

// ── Store ───────────────────────────────────────────────────

export const useSelfHealingStore = create<SelfHealingState>()(
	persist(
		(set, get) => ({
			// Initial state
			incidents: [],
			activeOperations: [],
			fragilityReports: [],
			stats: defaultStats,
			riskTrends: null,
			incidentClusters: [],
			bisects: {},
			cicdConfig: defaultCICDConfig,
			productionConfig: defaultProductionConfig,
			proactiveConfig: defaultProactiveConfig,
			activeTab: "cicd",
			isLoading: false,
			isScanning: false,
			error: null,

			// Simple setters
			setActiveTab: (tab) => set({ activeTab: tab }),
			setLoading: (loading) => set({ isLoading: loading }),
			setError: (error) => set({ error }),
			setScanning: (scanning) => set({ isScanning: scanning }),

			setDashboardData: (data) =>
				set({
					incidents: data.incidents,
					activeOperations: data.activeOperations,
					fragilityReports: data.fragilityReports,
					stats: data.stats,
					riskTrends: data.riskTrends ?? null,
					incidentClusters: data.incidentClusters ?? [],
				}),

			setIncidents: (incidents) => set({ incidents }),
			setFragilityReports: (reports) => set({ fragilityReports: reports }),
			setActiveOperations: (operations) =>
				set({ activeOperations: operations }),

			setCICDConfig: (projectPath, config) => {
				const merged = { ...get().cicdConfig, ...config };
				set({ cicdConfig: merged });
				// Persist to backend
				globalThis.electronAPI.selfHealing
					.cicdConfig(projectPath, merged)
					.catch(() => {
						/* noop */
					});
			},

			setProductionConfig: (projectPath, config) => {
				const merged = { ...get().productionConfig, ...config };
				set({ productionConfig: merged });
				globalThis.electronAPI.selfHealing
					.productionConfig(projectPath, merged)
					.catch(() => {
						/* noop */
					});
			},

			setProactiveConfig: (projectPath, config) => {
				const merged = { ...get().proactiveConfig, ...config };
				set({ proactiveConfig: merged });
				globalThis.electronAPI.selfHealing
					.proactiveConfig(projectPath, merged)
					.catch(() => {
						/* noop */
					});
			},

			// Async actions
			fetchDashboard: async (projectPath: string) => {
				set({ isLoading: true, error: null });
				try {
					const result =
						await globalThis.electronAPI.selfHealing.getDashboard(projectPath);
					if (result?.success && result.data) {
						const data = result.data as SelfHealingDashboardData & {
							cicdConfig?: CICDConfig;
							productionConfig?: ProductionConfig;
							proactiveConfig?: ProactiveConfig;
						};
						get().setDashboardData(data);
						// Restore persisted configs if present
						if (data.cicdConfig)
							set({ cicdConfig: { ...defaultCICDConfig, ...data.cicdConfig } });
						if (data.productionConfig)
							set({
								productionConfig: {
									...defaultProductionConfig,
									...data.productionConfig,
								},
							});
						if (data.proactiveConfig)
							set({
								proactiveConfig: {
									...defaultProactiveConfig,
									...data.proactiveConfig,
								},
							});
					}
				} catch (error) {
					set({ error: String(error) });
				} finally {
					set({ isLoading: false });
				}
			},

			triggerProactiveScan: async (projectPath: string) => {
				set({ isScanning: true, error: null });
				try {
					await globalThis.electronAPI.selfHealing.proactiveScan(projectPath);
					// Refresh dashboard after scan
					await get().fetchDashboard(projectPath);
				} catch (error) {
					set({ error: String(error) });
				} finally {
					set({ isScanning: false });
				}
			},

			triggerFix: async (projectPath: string, incidentId: string) => {
				try {
					await globalThis.electronAPI.selfHealing.triggerFix(
						projectPath,
						incidentId,
					);
					await get().fetchDashboard(projectPath);
				} catch (error) {
					set({ error: String(error) });
				}
			},

			dismissIncident: async (projectPath: string, incidentId: string) => {
				try {
					await globalThis.electronAPI.selfHealing.dismissIncident(
						projectPath,
						incidentId,
					);
					set((state) => ({
						incidents: state.incidents.map((i) =>
							i.id === incidentId ? { ...i, status: "resolved" as const } : i,
						),
					}));
				} catch (error) {
					set({ error: String(error) });
				}
			},

			retryIncident: async (projectPath: string, incidentId: string) => {
				try {
					await globalThis.electronAPI.selfHealing.retryIncident(
						projectPath,
						incidentId,
					);
					await get().fetchDashboard(projectPath);
				} catch (error) {
					set({ error: String(error) });
				}
			},

			startBisect: async (projectPath, incidentId, goodSha) => {
				set((state) => ({
					bisects: {
						...state.bisects,
						[incidentId]: { running: true, steps: [] },
					},
				}));
				let run: Partial<BisectRun>;
				try {
					const response =
						await globalThis.electronAPI.selfHealing.bisectIncident(
							projectPath,
							incidentId,
							goodSha || undefined,
						);
					run = response.success
						? { result: response.result }
						: { error: response.error ?? "bisect failed" };
				} catch (error) {
					run = { error: String(error) };
				}
				set((state) => ({
					bisects: {
						...state.bisects,
						[incidentId]: { ...state.bisects[incidentId], ...run, running: false },
					},
				}));
				if (run.result) await get().fetchDashboard(projectPath);
			},

			applyBisectProgress: (event) =>
				set((state) => {
					const current = state.bisects[event.incidentId] ?? {
						running: true,
						steps: [],
					};
					return {
						bisects: {
							...state.bisects,
							[event.incidentId]: {
								...current,
								steps: [...current.steps, event.step].slice(-50),
							},
						},
					};
				}),
		}),
		{
			name: "self-healing-config",
			partialize: (state) => ({
				cicdConfig: state.cicdConfig,
				productionConfig: state.productionConfig,
				proactiveConfig: state.proactiveConfig,
			}),
		},
	),
);

/** Registered once for the window by `global-listeners.ts`. */
export function setupSelfHealingListeners(): () => void {
	const api = globalThis.electronAPI?.selfHealing;
	if (!api?.onBisectProgress) return () => undefined;
	return api.onBisectProgress((event) =>
		useSelfHealingStore.getState().applyBisectProgress(event),
	);
}
