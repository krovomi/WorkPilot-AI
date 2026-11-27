/**
 * The server routes the phone app uses, typed. Every board route takes a
 * `project_id`, never a path (rule S5): the server resolves the clone.
 */

import type { ServerClient } from "./client";
import type {
	AgentRun,
	ApproveResult,
	AuthConfig,
	BoardCard,
	CardApproval,
	CardChanges,
	CardDetails,
	CardKind,
	Criticality,
	Delegation,
	ExecutionWavePlan,
	GovernanceReport,
	MyPermissions,
	PageVisitCount,
	ProjectMember,
	RunPhase,
	ServerProject,
	SteeringMessage,
	TaskLogs,
	UiPreferences,
	WaveHistory,
	WaveRunAnswer,
} from "./types";
import type { ThemePrefs } from "../ui/theme-ids";
import type { Leaderboard, LeaderboardPeriod, LeaderboardScope, ReplayShare } from "../team/types";
import type { Channel, ChannelSettings, Moment, NeedsYouOverview, TestResult } from "../needs-you/types";
import type { Memory } from "../context/index-file";
import type { MyUsage, UsageNotice } from "../usage/types";
import type { EngineOption, SettingsPayload } from "../new-card/engine";
import type { AnalysisKind, CostSummary, DashboardSnapshot, WorkSession } from "../insights/types";
import type {
	FeatureJob,
	FeatureJobOutput,
	FeatureSnapshot,
	InsightSession,
	InsightSummary,
} from "../features/types";

const enc = encodeURIComponent;

function cardsPath(projectId: string, cardId?: string, action?: string): string {
	const card = cardId ? `/${enc(cardId)}` : "";
	const verb = action ? `/${action}` : "";
	return `/api/board/cards${card}${verb}?project_id=${enc(projectId)}`;
}

/** A shared feature's route; `project_id` always in the query. */
function featurePath(feature: string, rest: string, projectId: string, query = ""): string {
	return `/api/features/${feature}${rest}?project_id=${enc(projectId)}${query}`;
}

export type JobFeature = "roadmap" | "ideation" | "context";

function runsPath(projectId: string, specId: string, rest = ""): string {
	return `/projects/${enc(projectId)}/specs/${enc(specId)}/runs${rest}`;
}

/** The personal tokens the server keeps for a person (`server/services/secrets.py`). */
export const SECRET_KINDS = ["github_token", "gitlab_token", "azure_pat", "jira_token", "linear_api_key", "sentry_token"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface NewCard {
	title: string;
	description: string;
	kind?: CardKind | null;
	requireReview: boolean;
	/** Engine and priority; left out, the card runs with the deployment's default. */
	settings?: SettingsPayload;
	/** Images, already checked on the phone (`new-card/images.ts`); the server checks again. */
	attachments?: { filename: string; mimeType: string; data: string }[];
}

export function api(client: ServerClient) {
	return {
		authConfig: () => client.publicRequest<AuthConfig>("GET", "/auth/config"),
		permissions: () => client.request<MyPermissions>("GET", "/auth/me/permissions"),
		/** How the current sign-in was opened; read through `auth/my-session.ts`, never shown raw. */
		mySession: () => client.request<unknown>("GET", "/auth/me/session"),
		projects: () => client.request<ServerProject[]>("GET", "/projects"),
		project: (projectId: string) => client.request<ServerProject>("GET", `/projects/${enc(projectId)}`),
		cards: async (projectId: string) =>
			(await client.request<{ cards: BoardCard[] }>("GET", cardsPath(projectId))).cards,
		card: (projectId: string, cardId: string) => client.request<CardDetails>("GET", cardsPath(projectId, cardId)),
		createCard: (projectId: string, card: NewCard) =>
			client.request<BoardCard>("POST", cardsPath(projectId), {
				title: card.title,
				description: card.description,
				kind: card.kind ?? null,
				require_review: card.requireReview,
				...(card.settings ? { settings: card.settings } : {}),
				...(card.attachments?.length ? { attachments: card.attachments } : {}),
			}),
		/** The providers and models a card may be created with (`shared_board/engines.py`). */
		engines: async (projectId: string) =>
			(await client.request<{ engines: EngineOption[] }>("GET", `/api/board/engines?project_id=${enc(projectId)}`))
				.engines,
		deleteCard: (projectId: string, cardId: string) => client.request("DELETE", cardsPath(projectId, cardId)),
		approve: (projectId: string, cardId: string) =>
			client.request<ApproveResult>("POST", cardsPath(projectId, cardId, "approve")),
		/** A card's criticality, its approvals and what is missing (`shared_board/approvals.py`). */
		approvals: (projectId: string, cardId: string) =>
			client.request<CardApproval>("GET", cardsPath(projectId, cardId, "approvals")),
		setCriticality: (projectId: string, cardId: string, criticality: Criticality) =>
			client.request<CardApproval>("PUT", cardsPath(projectId, cardId, "criticality"), { criticality }),
		/** The approvals lent on the project, running or to come. */
		delegations: (projectId: string) =>
			client.request<Delegation[]>("GET", `/api/board/delegations?project_id=${enc(projectId)}`),
		lendApproval: (projectId: string, toUserId: string, endsAt: string) =>
			client.request<Delegation>("POST", `/api/board/delegations?project_id=${enc(projectId)}`, {
				to_user_id: toUserId,
				ends_at: endsAt,
			}),
		endDelegation: (projectId: string, delegationId: string) =>
			client.request("DELETE", `/api/board/delegations/${enc(delegationId)}?project_id=${enc(projectId)}`),
		members: (projectId: string) => client.request<ProjectMember[]>("GET", `/projects/${enc(projectId)}/members`),
		changes: (projectId: string, cardId: string) =>
			client.request<CardChanges>("GET", cardsPath(projectId, cardId, "changes")),
		logs: async (projectId: string, cardId: string) =>
			(await client.request<{ logs: TaskLogs | null }>("GET", cardsPath(projectId, cardId, "logs"))).logs,
		steering: async (projectId: string, cardId: string) =>
			(await client.request<{ messages: SteeringMessage[] }>("GET", cardsPath(projectId, cardId, "steering")))
				.messages,
		steer: async (projectId: string, cardId: string, text: string) =>
			(
				await client.request<{ messages: SteeringMessage[] }>("POST", cardsPath(projectId, cardId, "steering"), {
					text,
					source: "mobile",
				})
			).messages,
		requestChanges: (projectId: string, cardId: string, feedback: string) =>
			client.request("POST", cardsPath(projectId, cardId, "request-changes"), { feedback }),
		runs: (projectId: string, specId: string) => client.request<AgentRun[]>("GET", runsPath(projectId, specId)),
		startRun: (projectId: string, specId: string, phase: RunPhase) =>
			client.request<AgentRun>("POST", runsPath(projectId, specId), { phase }),
		cancelRun: (projectId: string, specId: string, runId: string) =>
			client.request<{ cancelled: boolean }>("POST", runsPath(projectId, specId, `/${enc(runId)}/cancel`)),
		registerDevice: (token: string, platform: "ios" | "android", locale: string) =>
			client.request<{ registered: boolean }>("PUT", "/users/me/devices", { token, platform, locale }),
		unregisterDevice: (token: string) =>
			client.request<{ removed: boolean }>("DELETE", "/users/me/devices", { token }),
		updateCard: (projectId: string, cardId: string, changes: { title?: string; description?: string }) =>
			client.request<BoardCard>("PATCH", cardsPath(projectId, cardId), changes),
		insightSessions: (projectId: string) =>
			client.request<InsightSummary[]>("GET", featurePath("insights", "/sessions", projectId)),
		insightSession: (projectId: string, sessionId: string) =>
			client.request<InsightSession>("GET", featurePath("insights", `/sessions/${enc(sessionId)}`, projectId)),
		createInsight: (projectId: string) =>
			client.request<InsightSession>("POST", featurePath("insights", "/sessions", projectId), {}),
		deleteInsight: (projectId: string, sessionId: string) =>
			client.request<{ deleted: boolean }>("DELETE", featurePath("insights", `/sessions/${enc(sessionId)}`, projectId)),
		askInsight: (projectId: string, sessionId: string, message: string) =>
			client.request<{ job: FeatureJob; session: InsightSession }>(
				"POST",
				featurePath("insights", `/sessions/${enc(sessionId)}/messages`, projectId),
				{ message },
			),
		featureSnapshot: (feature: JobFeature, projectId: string) =>
			client.request<FeatureSnapshot>("GET", featurePath(feature, "/snapshot", projectId)),
		startFeatureJob: (feature: JobFeature, projectId: string, options: Record<string, unknown> = {}) =>
			client.request<FeatureJob>("POST", featurePath(feature, "/jobs", projectId), options),
		featureJob: (feature: JobFeature, projectId: string, jobId: string, after = 0) =>
			client.request<FeatureJobOutput>("GET", featurePath(feature, `/jobs/${enc(jobId)}`, projectId, `&after=${after}`)),
		cancelFeatureJob: (feature: JobFeature, projectId: string, jobId: string) =>
			client.request<{ cancelled: boolean }>("POST", featurePath(feature, `/jobs/${enc(jobId)}/cancel`, projectId)),
		convertRoadmapFeature: (projectId: string, featureId: string) =>
			client.request<{ card: { id: string } }>("POST", featurePath("roadmap", `/features/${enc(featureId)}/convert`, projectId)),
		convertIdea: (projectId: string, ideaId: string) =>
			client.request<{ card: { id: string } }>("POST", featurePath("ideation", `/ideas/${enc(ideaId)}/convert`, projectId)),
		dashboard: async (projectId: string) =>
			(await client.request<{ snapshot: DashboardSnapshot }>("GET", featurePath("workspace", "/dashboard", projectId)))
				.snapshot,
		costs: async (projectId: string) =>
			(await client.request<{ summary: CostSummary }>("GET", featurePath("workspace", "/costs", projectId))).summary,
		sessions: async (projectId: string) =>
			(
				await client.request<{ sessions: WorkSession[] }>(
					"GET",
					featurePath("workspace", "/sessions", projectId, "&limit=100"),
				)
			).sessions,
		/** The last saved report, and the run in progress if there is one. */
		analysisReport: async (kind: AnalysisKind, projectId: string) => {
			const got = await client.request<{ report: string | null; job?: FeatureJob | null }>(
				"GET",
				featurePath("analyses", `/${kind}/report`, projectId),
			);
			return { report: got.report, job: got.job ?? null };
		},
		startAnalysis: (kind: AnalysisKind, projectId: string) =>
			client.request<FeatureJob>("POST", featurePath("analyses", `/${kind}/jobs`, projectId), {}),
		analysisJob: (kind: AnalysisKind, projectId: string, jobId: string) =>
			client.request<FeatureJobOutput>("GET", featurePath("analyses", `/${kind}/jobs/${enc(jobId)}`, projectId)),
		cancelAnalysis: (kind: AnalysisKind, projectId: string, jobId: string) =>
			client.request<{ cancelled: boolean }>("POST", featurePath("analyses", `/${kind}/jobs/${enc(jobId)}/cancel`, projectId)),
		memories: async (projectId: string, query: string) => {
			const q = query.trim();
			const found = await client.request<{ available: boolean; memories?: Memory[]; results?: Memory[] }>(
				"GET",
				featurePath("context", "/memories", projectId, `&limit=50${q ? `&query=${enc(q)}` : ""}`),
			);
			return { available: found.available, memories: (q ? found.results : found.memories) ?? [] };
		},
		/** The policy of the project, its waiting calls and its agents, as the server reads them. */
		governance: (projectId: string) =>
			client.request<GovernanceReport>("GET", featurePath("governance", "", projectId)),
		/** Approve or refuse a waiting call, in the name of the person signed in. */
		answerGovernance: (projectId: string, requestId: string, approved: boolean) =>
			client.request<{ answer: { decision: "approved" | "refused" } }>(
				"POST",
				featurePath("governance", `/approvals/${enc(requestId)}`, projectId),
				{ approved },
			),
		/** The kill switch of the project: the person's agents, or (its owner) all of them. */
		stopGovernance: (projectId: string, scope: "mine" | "project") =>
			client.request<{ stoppedRuns: number; stoppedJobs: number }>(
				"POST",
				featurePath("governance", "/stop", projectId),
				{ scope },
			),
		/** The waves of the backlog, as the server plans them now. */
		wavePlan: (projectId: string) =>
			client.request<ExecutionWavePlan>("GET", featurePath("execution-waves", "/plan", projectId)),
		waveRun: (projectId: string) =>
			client.request<WaveRunAnswer>("GET", featurePath("execution-waves", "/run", projectId)),
		/** Plans the backlog and starts its first wave, as the person signed in. */
		startWaveRun: (projectId: string, advanceWhen: "merged" | "review") =>
			client.request<WaveRunAnswer>("POST", featurePath("execution-waves", "/run", projectId), { advanceWhen }),
		/** Starts what may start now; the next wave once this one settled. */
		stepWaveRun: (projectId: string) =>
			client.request<WaveRunAnswer>("POST", featurePath("execution-waves", "/run/step", projectId)),
		stopWaveRun: (projectId: string) =>
			client.request<WaveRunAnswer>("DELETE", featurePath("execution-waves", "/run", projectId)),
		waveHistory: (projectId: string) =>
			client.request<WaveHistory>("GET", featurePath("execution-waves", "/history", projectId)),
		secretKinds: async () => (await client.request<{ kinds: string[] }>("GET", "/users/me/secrets")).kinds,
		setSecret: (kind: SecretKind, value: string) =>
			client.request<{ saved: boolean }>("PUT", "/users/me/secrets", { kind, value }),
		deleteSecret: (kind: SecretKind) =>
			client.request<{ deleted: boolean }>("DELETE", `/users/me/secrets/${enc(kind)}`),
		preferences: () => client.request<UiPreferences>("GET", "/users/me/preferences"),
		setPreferences: (prefs: ThemePrefs) =>
			client.request<UiPreferences>("PUT", "/users/me/preferences", {
				theme: prefs.theme,
				colorTheme: prefs.colorTheme,
			}),
		/** The person's own "needs you" channels and moments (`server/routers/needs_you.py`). */
		needsYou: () => client.request<NeedsYouOverview>("GET", "/users/me/needs-you"),
		saveNeedsYouChannel: (channel: Channel, settings: ChannelSettings) =>
			client.request<{ saved: boolean }>("PUT", `/users/me/needs-you/channels/${enc(channel)}`, settings),
		deleteNeedsYouChannel: (channel: Channel) =>
			client.request<{ deleted: boolean }>("DELETE", `/users/me/needs-you/channels/${enc(channel)}`),
		testNeedsYouChannel: async (channel: Channel) =>
			(await client.request<{ result: TestResult }>("POST", `/users/me/needs-you/channels/${enc(channel)}/test`))
				.result,
		saveNeedsYouMoments: (events: Record<Moment, boolean>, locale: string) =>
			client.request<{ saved: boolean }>("PUT", "/users/me/needs-you/preferences", { events, locale }),
		/** The team's leaderboard: only those who agreed are named (`shared_features/pixel_office.py`). */
		leaderboard: (projectId: string, scope: LeaderboardScope, period: LeaderboardPeriod) =>
			client.request<Leaderboard>("GET", featurePath("pixel-office", "/leaderboard", projectId, `&scope=${scope}&period=${period}`)),
		/** Shows, or stops showing, the person's own name on the organization's leaderboards. */
		setLeaderboardConsent: (projectId: string, visible: boolean) =>
			client.request<{ visible: boolean }>("PUT", featurePath("pixel-office", "/consent", projectId), { visible }),
		/** The replay links the person made, on every project they still reach. */
		myReplayShares: async () =>
			(await client.request<{ shares: ReplayShare[] }>("GET", "/api/features/replay-shares/mine")).shares,
		revokeReplayShare: (projectId: string, shareId: string) =>
			client.request<{ revoked: boolean }>("DELETE", featurePath("replay-shares", `/${enc(shareId)}`, projectId)),
		streamInfo: () => client.request<{ url: string | null }>("GET", "/api/board/stream"),
		/** What the organization's administrators see of the person, for these UTC days. */
		myUsage: (start: string, end: string) =>
			client.request<MyUsage>("GET", `/users/me/usage?start=${enc(start)}&end=${enc(end)}`),
		/** Everything the server keeps about the person's usage, as JSON text. */
		exportMyUsage: async () =>
			JSON.stringify(await client.request<unknown>("GET", "/users/me/usage/export"), null, 2),
		/** What is measured, and whether the person still has to be told. */
		usageNotice: () => client.request<UsageNotice>("GET", "/users/me/usage-notice"),
		/** The person read the notice; the server records it. */
		markUsageNoticeSeen: () => client.request<UsageNotice>("POST", "/users/me/usage-notice"),
		/** Whether the person's organization counts which screens they open. */
		pageActivity: () => client.request<{ enabled: boolean }>("GET", "/users/me/page-activity"),
		/** Today's opens per screen (`usage/pages.ts` names only). */
		sendPageActivity: (visits: PageVisitCount[]) =>
			client.request<{ enabled: boolean; recorded: number }>("POST", "/users/me/page-activity", {
				client: "mobile",
				visits,
			}),
	};
}

export type Api = ReturnType<typeof api>;
