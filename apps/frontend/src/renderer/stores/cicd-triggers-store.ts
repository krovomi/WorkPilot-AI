import { create } from "zustand";
import type { DeployWatch } from "../../shared/types/deploy-watch";

export type CICDProvider = "github" | "gitlab" | "azure" | "jenkins" | "";
export type PipelineRunStatus =
	| "pending"
	| "triggered"
	| "running"
	| "success"
	| "failed";

export interface CICDConfig {
	provider: CICDProvider;
	enabled: boolean;
	trigger_on_pr: boolean;
	trigger_on_merge: boolean;
	github_token: string;
	github_workflow: string;
	github_ref: string;
	gitlab_token: string;
	gitlab_project_id: string;
	gitlab_ref: string;
	azure_token: string;
	azure_org: string;
	azure_project: string;
	azure_pipeline_id: string;
	jenkins_url: string;
	jenkins_token: string;
	jenkins_job: string;
	/** The watch after a deployment (#366): what to read, how long. */
	monitor_health_url: string;
	monitor_prometheus_url: string;
	monitor_prometheus_token: string;
	monitor_window_minutes: string;
	monitor_deploy_wait_minutes: string;
	auto_rollback: boolean;
}

export interface PipelineRun {
	id: string;
	triggered_at: string;
	status: PipelineRunStatus;
	provider: string;
	pr_url: string;
	branch: string;
	error?: string;
	run_data?: unknown;
	/** "auto": started after an agent opened the PR; absent or "manual" otherwise. */
	source?: "manual" | "auto";
	event?: "pr" | "merge";
	task_id?: string;
	spec_id?: string;
	/** The watch after the deployment, when one was started. */
	watch?: DeployWatch;
}

interface CICDTriggersState {
	config: CICDConfig | null;
	runs: PipelineRun[];
	isLoading: boolean;
	isTriggering: boolean;
	error: string | null;

	loadConfig: (projectDir: string) => Promise<void>;
	setConfig: (projectDir: string, config: Partial<CICDConfig>) => Promise<void>;
	loadRuns: (projectDir: string, limit?: number) => Promise<void>;
	triggerPipeline: (
		projectDir: string,
		params: {
			provider: string;
			prUrl?: string;
			branch?: string;
			workflow?: string;
		},
	) => Promise<{ success: boolean; error?: string }>;
	/** Rolls a watched run back; the person asked for it on the page. */
	rollback: (projectDir: string, runId: string) => Promise<boolean>;
	rollingBack: string | null;
	clearError: () => void;
}

export const useCICDTriggersStore = create<CICDTriggersState>((set, get) => ({
	config: null,
	runs: [],
	isLoading: false,
	isTriggering: false,
	error: null,
	rollingBack: null,

	loadConfig: async (projectDir) => {
		set({ isLoading: true, error: null });
		try {
			const result = await globalThis.electronAPI.invoke(
				"cicdTriggers:getConfig",
				projectDir,
			);
			if (result.success) {
				set({ config: result.data as CICDConfig });
			} else {
				set({ error: result.error ?? "Failed to load CI/CD config" });
			}
		} catch (err) {
			set({ error: String(err) });
		} finally {
			set({ isLoading: false });
		}
	},

	setConfig: async (projectDir, config) => {
		try {
			const flat: Record<string, string> = {};
			for (const [key, value] of Object.entries(config)) {
				flat[key] = String(value);
			}
			await globalThis.electronAPI.invoke(
				"cicdTriggers:setConfig",
				projectDir,
				flat,
			);
			set((state) => ({
				config: state.config
					? { ...state.config, ...config }
					: (config as CICDConfig),
			}));
		} catch (err) {
			set({ error: String(err) });
		}
	},

	loadRuns: async (projectDir, limit = 50) => {
		try {
			const result = await globalThis.electronAPI.invoke(
				"cicdTriggers:listRuns",
				projectDir,
				limit,
			);
			if (result.success) {
				set({ runs: result.data as PipelineRun[] });
			} else {
				set({ error: result.error ?? "Failed to load runs" });
			}
		} catch (err) {
			set({ error: String(err) });
		}
	},

	triggerPipeline: async (projectDir, params) => {
		set({ isTriggering: true, error: null });
		try {
			const result = await globalThis.electronAPI.invoke(
				"cicdTriggers:trigger",
				projectDir,
				{
					provider: params.provider,
					pr_url: params.prUrl,
					branch: params.branch,
					workflow: params.workflow,
				},
			);
			if (result.success) {
				// Refresh runs list
				await get().loadRuns(projectDir);
				return { success: true };
			}
			const err = result.error ?? "Trigger failed";
			set({ error: err });
			return { success: false, error: err };
		} catch (err) {
			const msg = String(err);
			set({ error: msg });
			return { success: false, error: msg };
		} finally {
			set({ isTriggering: false });
		}
	},

	rollback: async (projectDir, runId) => {
		set({ rollingBack: runId, error: null });
		try {
			const result = await globalThis.electronAPI.rollbackDeployment(projectDir, runId);
			if (!result.success) {
				set({ error: result.error ?? "Rollback failed" });
				return false;
			}
			await get().loadRuns(projectDir);
			return true;
		} catch (err) {
			set({ error: String(err) });
			return false;
		} finally {
			set({ rollingBack: null });
		}
	},

	clearError: () => set({ error: null }),
}));
