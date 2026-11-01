/**
 * The server routes the phone app uses, typed. Every board route takes a
 * `project_id`, never a path (rule S5): the server resolves the clone.
 */

import type { ServerClient } from "./client";
import type {
	AgentRun,
	AuthConfig,
	BoardCard,
	CardChanges,
	CardDetails,
	CardKind,
	MyPermissions,
	RunPhase,
	ServerProject,
	TaskLogs,
	UiPreferences,
} from "./types";
import type { ThemePrefs } from "../ui/theme-ids";
import type { Memory } from "../context/index-file";
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
export const SECRET_KINDS = ["github_token", "gitlab_token", "azure_pat", "jira_token", "linear_api_key"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface NewCard {
	title: string;
	description: string;
	kind?: CardKind | null;
	requireReview: boolean;
}

export function api(client: ServerClient) {
	return {
		authConfig: () => client.publicRequest<AuthConfig>("GET", "/auth/config"),
		permissions: () => client.request<MyPermissions>("GET", "/auth/me/permissions"),
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
			}),
		deleteCard: (projectId: string, cardId: string) => client.request("DELETE", cardsPath(projectId, cardId)),
		approve: (projectId: string, cardId: string) => client.request("POST", cardsPath(projectId, cardId, "approve")),
		changes: (projectId: string, cardId: string) =>
			client.request<CardChanges>("GET", cardsPath(projectId, cardId, "changes")),
		logs: async (projectId: string, cardId: string) =>
			(await client.request<{ logs: TaskLogs | null }>("GET", cardsPath(projectId, cardId, "logs"))).logs,
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
		cancelInsightJob: (projectId: string, jobId: string) =>
			client.request<{ cancelled: boolean }>("POST", featurePath("insights", `/jobs/${enc(jobId)}/cancel`, projectId)),
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
		analysisReport: async (kind: AnalysisKind, projectId: string) =>
			(await client.request<{ report: string | null }>("GET", featurePath("analyses", `/${kind}/report`, projectId)))
				.report,
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
		streamInfo: () => client.request<{ url: string | null }>("GET", "/api/board/stream"),
	};
}

export type Api = ReturnType<typeof api>;
