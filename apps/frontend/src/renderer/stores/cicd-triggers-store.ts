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

/**
 * The project the dashboard is on. Config and runs read for a project left
 * behind are dropped: the dashboard would show, and then save, another
 * project's settings.
 */
let shownProject: string | null = null;
const isShown = (projectDir: string) => projectDir === shownProject;

/** The dashboard opened on a project: the last project's data is not its. */
function show(projectDir: string): void {
	if (!isShown(projectDir)) {
		useCICDTriggersStore.setState({ config: null, runs: [] });
	}
	shownProject = projectDir;
}

/** Read the runs again for the project on screen, after a change. */
async function readRuns(projectDir: string, limit = 50): Promise<void> {
	try {
		const result = await globalThis.electronAPI.invoke(
			"cicdTriggers:listRuns",
			projectDir,
			limit,
		);
		if (!isShown(projectDir)) return;
		if (result.success) {
			useCICDTriggersStore.setState({ runs: result.data as PipelineRun[] });
		} else {
			useCICDTriggersStore.setState({ error: result.error ?? "Failed to load runs" });
		}
	} catch (err) {
		if (isShown(projectDir)) useCICDTriggersStore.setState({ error: String(err) });
	}
}

export const useCICDTriggersStore = create<CICDTriggersState>((set) => ({
	config: null,
	runs: [],
	isLoading: false,
	isTriggering: false,
	error: null,
	rollingBack: null,

	loadConfig: async (projectDir) => {
		show(projectDir);
		set({ isLoading: true, error: null });
		try {
			const result = await globalThis.electronAPI.invoke(
				"cicdTriggers:getConfig",
				projectDir,
			);
			if (!isShown(projectDir)) return;
			if (result.success) {
				set({ config: result.data as CICDConfig });
			} else {
				set({ error: result.error ?? "Failed to load CI/CD config" });
			}
		} catch (err) {
			if (isShown(projectDir)) set({ error: String(err) });
		} finally {
			if (isShown(projectDir)) set({ isLoading: false });
		}
	},

	setConfig: async (projectDir, config) => {
		try {
			const flat: Record<string, string> = {};
			for (const [key, value] of Object.entries(config)) {
				flat[key] = String(value);
			}
			const result = await globalThis.electronAPI.invoke(
				"cicdTriggers:setConfig",
				projectDir,
				flat,
			);
			// Refused by the main process: nothing was written, so the page
			// must not show the new values as saved.
			// Another project is shown now: neither the values nor a refusal
			// are its own.
			if (!isShown(projectDir)) return;
			if (!result?.success) {
				set({ error: result?.error ?? "Failed to save CI/CD config" });
				return;
			}
			set((state) => ({
				config: state.config
					? { ...state.config, ...config }
					: (config as CICDConfig),
			}));
		} catch (err) {
			if (isShown(projectDir)) set({ error: String(err) });
		}
	},

	loadRuns: async (projectDir, limit = 50) => {
		show(projectDir);
		await readRuns(projectDir, limit);
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
				await readRuns(projectDir);
				return { success: true };
			}
			const err = result.error ?? "Trigger failed";
			if (isShown(projectDir)) set({ error: err });
			return { success: false, error: err };
		} catch (err) {
			const msg = String(err);
			if (isShown(projectDir)) set({ error: msg });
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
				if (isShown(projectDir)) set({ error: result.error ?? "Rollback failed" });
				return false;
			}
			await readRuns(projectDir);
			return true;
		} catch (err) {
			if (isShown(projectDir)) set({ error: String(err) });
			return false;
		} finally {
			set({ rollingBack: null });
		}
	},

	clearError: () => set({ error: null }),
}));
