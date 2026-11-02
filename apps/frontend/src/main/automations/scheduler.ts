/**
 * Runs every project's rules on a timer while the app is open, one pass per
 * project at a time. It replaces the continuous-AI daemon: no second
 * process, no action outside the app — a rule only ever creates a card or
 * starts a PR review that stays a draft.
 */

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { AutomationsEvent, Project } from "../../shared/types";
import type { AgentManager } from "../agent";
import { appLog } from "../app-logger";
import { readMergedProjectEnv } from "../ci-pipeline-service";
import { resolvePipelineProvider } from "../ci-pipeline-providers";
import {
	getGitHubConfig,
	githubFetch,
	normalizeRepoReference,
} from "../ipc-handlers/github/utils";
import {
	encodeProjectPath,
	getGitLabConfig,
	gitlabFetch,
	normalizeProjectReference,
} from "../ipc-handlers/gitlab/utils";
import { projectStore } from "../project-store";
import { createAutomationCard, issueNumbersOnBoard } from "./cards";
import { livePRReviews } from "./pr-review";
import { type RunDeps, type RunSummary, runProjectAutomations } from "./run";
import {
	ciFailedEvents,
	type GitHubSource,
	issueLabeledEvents,
	prOpenedEvents,
	SourceError,
	scheduleEvents,
} from "./sources";
import { type GitLabSource, gitlabIssueLabeledEvents } from "./sources-gitlab";
import { readRules } from "./store";

export const PASS_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_PASS_DELAY_MS = 30 * 1000;

/**
 * The project's issue tracker for an `issue_labeled` rule: its GitHub when
 * connected, else its GitLab (Settings › GitLab), else an error naming both.
 */
async function issueSource(
	project: Project,
): Promise<{ github: GitHubSource } | { gitlab: GitLabSource }> {
	if (getGitHubConfig(project)) return { github: githubSource(project) };
	const config = await getGitLabConfig(project);
	if (!config) {
		throw new SourceError(
			"forge_not_connected",
			"Neither GitHub nor GitLab is connected for this project",
		);
	}
	let host = config.instanceUrl;
	try {
		host = new URL(config.instanceUrl).host;
	} catch {
		// A malformed URL fails the fetch itself, with its own message.
	}
	const ref = normalizeProjectReference(config.project, config.instanceUrl);
	const base = `/projects/${encodeProjectPath(ref)}`;
	return {
		gitlab: {
			slug: `${host}/${ref}`,
			fetch: (endpoint) => gitlabFetch(config.token, config.instanceUrl, `${base}${endpoint}`),
		},
	};
}

function githubSource(project: Project): GitHubSource {
	const config = getGitHubConfig(project);
	if (!config) {
		throw new SourceError("github_not_connected", "GitHub is not connected for this project");
	}
	return {
		repo: normalizeRepoReference(config.repo),
		fetch: (endpoint) => githubFetch(config.token, endpoint),
	};
}

export function liveDeps(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null = () => null,
): RunDeps {
	const reviews = livePRReviews(getMainWindow);
	return {
		now: () => new Date(),
		async readSource(project, rule, ledger) {
			const trigger = rule.trigger;
			const seen = (key: string) => Boolean(ledger.seen[key]);
			switch (trigger.type) {
				case "issue_labeled": {
					const source = await issueSource(project);
					return "github" in source
						? issueLabeledEvents({ ...rule, trigger }, source.github, seen)
						: gitlabIssueLabeledEvents({ ...rule, trigger }, source.gitlab, seen);
				}
				case "pr_opened":
					return prOpenedEvents({ ...rule, trigger }, githubSource(project), seen);
				case "ci_failed": {
					const adapter = await resolvePipelineProvider(
						project,
						readMergedProjectEnv(project),
					);
					return ciFailedEvents({ ...rule, trigger }, project, adapter);
				}
				case "schedule":
					return scheduleEvents({ ...rule, trigger }, new Date());
			}
		},
		createCard: createAutomationCard,
		async startCard(project, card) {
			await agentManager.startSpecCreation(
				card.specId,
				project.path,
				card.description,
				card.specDir,
				card.metadata,
			);
		},
		isCardOpen(project, specId) {
			const task = projectStore
				.getTasks(project.id)
				.find((t) => t.specId === specId || t.id === specId);
			return Boolean(task && task.status !== "done" && !task.metadata?.archivedAt);
		},
		issueNumbersOnBoard,
		hasPRReview: (project, prNumber) => reviews.has(project, prNumber),
		startPRReview: (project, prNumber) => reviews.start(project, prNumber),
	};
}

export class AutomationScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private firstPass: ReturnType<typeof setTimeout> | null = null;
	private readonly passes = new Map<string, Promise<RunSummary>>();

	constructor(
		private readonly deps: RunDeps,
		private readonly getMainWindow: () => BrowserWindow | null,
	) {}

	start(): void {
		if (this.timer) return;
		this.firstPass = setTimeout(() => void this.runAll(), FIRST_PASS_DELAY_MS);
		this.timer = setInterval(() => void this.runAll(), PASS_INTERVAL_MS);
	}

	stop(): void {
		if (this.firstPass) clearTimeout(this.firstPass);
		if (this.timer) clearInterval(this.timer);
		this.firstPass = null;
		this.timer = null;
	}

	async runAll(): Promise<void> {
		for (const project of projectStore.getProjects()) {
			// A server project's rules run on the server, for the whole team.
			if (project.remote || !project.autoBuildPath) continue;
			if (!readRules(project).some((rule) => rule.enabled)) continue;
			await this.run(project);
		}
	}

	/** One pass for `project`; a pass already running is joined, not doubled. */
	run(project: Project): Promise<RunSummary> {
		// Never twice: the server runs a server project's rules.
		if (project.remote) return Promise.resolve({ created: 0, reviews: 0, errors: 0 });
		const running = this.passes.get(project.id);
		if (running) return running;
		const pass = runProjectAutomations(project, this.deps)
			.then((summary) => {
				if (summary.created > 0) projectStore.invalidateTasksCache(project.id);
				if (summary.created > 0 || summary.reviews > 0 || summary.errors > 0) {
					const event: AutomationsEvent = {
						projectId: project.id,
						created: summary.created,
						reviews: summary.reviews,
					};
					this.getMainWindow()?.webContents.send(IPC_CHANNELS.AUTOMATIONS_EVENT, event);
				}
				return summary;
			})
			.catch((error) => {
				appLog.warn(`[Automations] pass failed for ${project.name}:`, error);
				return { created: 0, reviews: 0, errors: 1 };
			})
			.finally(() => this.passes.delete(project.id));
		this.passes.set(project.id, pass);
		return pass;
	}
}
