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
} from "./types";

const enc = encodeURIComponent;

function cardsPath(projectId: string, cardId?: string, action?: string): string {
	const card = cardId ? `/${enc(cardId)}` : "";
	const verb = action ? `/${action}` : "";
	return `/api/board/cards${card}${verb}?project_id=${enc(projectId)}`;
}

function runsPath(projectId: string, specId: string, rest = ""): string {
	return `/projects/${enc(projectId)}/specs/${enc(specId)}/runs${rest}`;
}

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
		requestChanges: (projectId: string, cardId: string, feedback: string) =>
			client.request("POST", cardsPath(projectId, cardId, "request-changes"), { feedback }),
		runs: (projectId: string, specId: string) => client.request<AgentRun[]>("GET", runsPath(projectId, specId)),
		startRun: (projectId: string, specId: string, phase: RunPhase) =>
			client.request<AgentRun>("POST", runsPath(projectId, specId), { phase }),
		cancelRun: (projectId: string, specId: string, runId: string) =>
			client.request<{ cancelled: boolean }>("POST", runsPath(projectId, specId, `/${enc(runId)}/cancel`)),
		streamInfo: () => client.request<{ url: string | null }>("GET", "/api/board/stream"),
	};
}

export type Api = ReturnType<typeof api>;
