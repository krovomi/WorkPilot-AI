import { create } from "zustand";
import type {
	DeployLinksView,
	DeployVerdictReview,
	DeployWatch,
	DeployWatchFigures,
} from "../../shared/types/deploy-watch";

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
	/** prometheus (default) | datadog | newrelic | cloudwatch | grafana, and their settings. */
	monitor_source: string;
	monitor_datadog_site: string;
	monitor_datadog_api_key: string;
	monitor_datadog_app_key: string;
	monitor_newrelic_region: string;
	monitor_newrelic_account_id: string;
	monitor_newrelic_api_key: string;
	monitor_aws_region: string;
	monitor_aws_access_key_id: string;
	monitor_aws_secret_access_key: string;
	monitor_aws_session_token: string;
	monitor_grafana_url: string;
	monitor_grafana_token: string;
	monitor_grafana_datasource_uid: string;
	/** Where the alert of a bad verdict goes. Secrets come back masked. */
	alert_slack_webhook_url: string;
	alert_pagerduty_routing_key: string;
	alert_pagerduty_region: string;
	alert_email_to: string;
	alert_email_from: string;
	alert_smtp_host: string;
	alert_smtp_port: string;
	alert_smtp_user: string;
	alert_smtp_password: string;
	/** The feature flag a critical verdict turns off (unleash | launchdarkly | configcat). */
	rollback_flag_provider: string;
	rollback_flag_url: string;
	rollback_flag_key: string;
	rollback_flag_project: string;
	rollback_flag_environment: string;
	rollback_flag_user: string;
	rollback_flag_token: string;
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
	/** The projects rolled back with this one (#366, lot 4). */
	links: DeployLinksView | null;
	loadLinks: (projectDir: string) => Promise<void>;
	saveLinks: (projectDir: string, projectIds: string[]) => Promise<void>;
	/** The watch figures, computed on this machine. */
	figures: DeployWatchFigures | null;
	loadFigures: (projectDir: string) => Promise<void>;
	/** A person's word on a bad verdict; null takes it back. */
	reviewVerdict: (projectDir: string, runId: string, review: DeployVerdictReview | null) => Promise<void>;
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
		useCICDTriggersStore.setState({ config: null, runs: [], links: null, figures: null });
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
	links: null,
	figures: null,

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
			await readFigures(projectDir);
			return true;
		} catch (err) {
			if (isShown(projectDir)) set({ error: String(err) });
			return false;
		} finally {
			set({ rollingBack: null });
		}
	},

	loadLinks: async (projectDir) => {
		show(projectDir);
		await answer(projectDir, () => globalThis.electronAPI.getDeployLinks(projectDir), (links) => set({ links }));
	},

	saveLinks: async (projectDir, projectIds) => {
		await answer(projectDir, () => globalThis.electronAPI.setDeployLinks(projectDir, projectIds), (links) =>
			set({ links }),
		);
	},

	loadFigures: async (projectDir) => {
		show(projectDir);
		await readFigures(projectDir);
	},

	reviewVerdict: async (projectDir, runId, review) => {
		await answer(projectDir, () => globalThis.electronAPI.reviewDeployVerdict(projectDir, runId, review), () => undefined);
		if (!isShown(projectDir)) return;
		await readRuns(projectDir);
		await readFigures(projectDir);
	},

	clearError: () => set({ error: null }),
}));

/** Applies a typed call's answer for the project on screen, or shows its error. */
async function answer<T>(
	projectDir: string,
	call: () => Promise<{ success: boolean; data?: T; error?: string }>,
	apply: (data: T) => void,
): Promise<void> {
	try {
		const result = await call();
		if (!isShown(projectDir)) return;
		if (result.success) apply(result.data as T);
		else useCICDTriggersStore.setState({ error: result.error ?? "Request failed" });
	} catch (err) {
		if (isShown(projectDir)) useCICDTriggersStore.setState({ error: String(err) });
	}
}

async function readFigures(projectDir: string): Promise<void> {
	await answer(projectDir, () => globalThis.electronAPI.getDeployFigures(projectDir), (figures) =>
		useCICDTriggersStore.setState({ figures }),
	);
}
