import { create } from "zustand";
import { canSaveOfflinePolicy, newLocalRoute } from "./offline-mode-routing";
import type {
	OfflineModelCatalog,
	OfflinePolicy,
	OfflineReport,
	OfflineStatus,
} from "../../preload/api/modules/offline-mode-api";

interface OfflineModeState {
	savedPolicy: OfflinePolicy | null;
	projectPath: string | null;
	status: OfflineStatus | null;
	policy: OfflinePolicy | null;
	report: OfflineReport | null;
	catalog: OfflineModelCatalog | null;
	loading: boolean;
	saving: boolean;
	scanning: boolean;
	error: string | null;
	dirty: boolean;

	loadAll: (projectPath: string) => Promise<void>;
	refreshStatus: (projectPath: string) => Promise<void>;
	scan: (projectPath: string, force?: boolean) => Promise<void>;
	setAirgap: (value: boolean) => void;
	setDefaultProvider: (provider: string) => void;
	setRouting: (task: string, provider: string, model: string) => void;
	addRoutingRow: (task: string) => void;
	removeRoutingRow: (task: string) => void;
	save: (projectPath: string) => Promise<void>;
}

export const useOfflineModeStore = create<OfflineModeState>((set, get) => ({
	savedPolicy: null,
	projectPath: null,
	status: null,
	policy: null,
	report: null,
	catalog: null,
	loading: false,
	saving: false,
	scanning: false,
	error: null,
	dirty: false,

	loadAll: async (projectPath) => {
		set({
			projectPath,
			status: null,
			policy: null,
			savedPolicy: null,
			catalog: null,
			report: null,
			dirty: false,
			saving: false,
			scanning: false,
			loading: true,
			error: null,
		});
		try {
			const [status, policyRes, report, catalog] = await Promise.all([
				globalThis.electronAPI.getOfflineStatus(projectPath),
				globalThis.electronAPI.getOfflinePolicy(projectPath),
				globalThis.electronAPI.getOfflineReport(projectPath),
				globalThis.electronAPI.scanOfflineModels(projectPath),
			]);
			if (get().projectPath !== projectPath) return;
			set({
				status,
				policy: policyRes.policy,
				savedPolicy: policyRes.persisted === false ? null : policyRes.policy,
				report,
				catalog,
				loading: false,
				dirty: policyRes.persisted === false,
			});
		} catch (e) {
			if (get().projectPath === projectPath)
				set({ error: String(e), loading: false });
		}
	},

	refreshStatus: async (projectPath) => get().scan(projectPath, true),

	scan: async (projectPath, force) => {
		if (get().projectPath !== projectPath) return;
		set({ scanning: true, error: null });
		try {
			const [catalog, status] = await Promise.all([
				globalThis.electronAPI.scanOfflineModels(projectPath, force),
				globalThis.electronAPI.getOfflineStatus(projectPath),
			]);
			if (get().projectPath === projectPath)
				set({ catalog, status, scanning: false });
		} catch (e) {
			if (get().projectPath === projectPath)
				set({ error: String(e), scanning: false });
		}
	},

	setDefaultProvider: (provider) =>
		set((s) =>
			s.policy
				? {
						policy: {
							...s.policy,
							defaultProvider: newLocalRoute(s.catalog, provider).provider,
						},
						dirty: true,
					}
				: s,
		),

	setAirgap: (value) =>
		set((s) =>
			s.policy
				? { policy: { ...s.policy, airgapStrict: value }, dirty: true }
				: s,
		),

	setRouting: (task, provider, model) =>
		set((s) =>
			s.policy
				? {
						policy: {
							...s.policy,
							routing: { ...s.policy.routing, [task]: { provider, model } },
						},
						dirty: true,
					}
				: s,
		),

	addRoutingRow: (task) =>
		set((s) => {
			if (!s.policy || !task.trim()) return s;
			if (s.policy.routing[task]) return s;
			return {
				policy: {
					...s.policy,
					routing: {
						...s.policy.routing,
						[task]: newLocalRoute(s.catalog, s.policy.defaultProvider),
					},
				},
				dirty: true,
			};
		}),

	removeRoutingRow: (task) =>
		set((s) => {
			if (!s.policy) return s;
			const { [task]: _, ...rest } = s.policy.routing;
			return { policy: { ...s.policy, routing: rest }, dirty: true };
		}),

	save: async (projectPath) => {
		const policy = get().policy;
		if (!policy || get().projectPath !== projectPath) return;
		if (!canSaveOfflinePolicy(policy, get().catalog, get().savedPolicy)) {
			set({ error: "offlineMode:invalidPolicy" });
			return;
		}
		set({ saving: true, error: null });
		try {
			await globalThis.electronAPI.setOfflinePolicy(projectPath, policy);
			if (get().projectPath === projectPath)
				set({
					saving: false,
					savedPolicy: policy,
					dirty: get().policy !== policy,
				});
		} catch (e) {
			if (get().projectPath === projectPath)
				set({ error: String(e), saving: false });
		}
	},
}));
