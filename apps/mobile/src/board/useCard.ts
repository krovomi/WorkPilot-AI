/** One card on screen: its summary from the board, its details, runs, changes and build log. */

import { useCallback } from "react";
import type { AgentRun, BoardCard, CardChanges, CardDetails, TaskLogs } from "../api/types";
import { useApi } from "../auth/session";
import { useLoad } from "../hooks/useLoad";

export interface CardData {
	card: BoardCard;
	details: CardDetails;
	runs: AgentRun[];
	changes: CardChanges | null;
	logs: TaskLogs | null;
}

export function useCard(projectId: string, cardId: string) {
	const api = useApi();
	const load = useCallback(async (): Promise<CardData> => {
		const [cards, details] = await Promise.all([api.cards(projectId), api.card(projectId, cardId)]);
		const card = cards.find((c) => c.id === cardId);
		if (!card) throw new Error("card_not_indexed");
		const [runs, changes, logs] = await Promise.all([
			card.specId ? api.runs(projectId, card.specId) : Promise.resolve([]),
			// The changes are a convenience: a card whose diff cannot be read still shows.
			api.changes(projectId, cardId).catch(() => null),
			// So is the build log.
			api.logs(projectId, cardId).catch(() => null),
		]);
		return { card, details, runs, changes, logs };
	}, [api, projectId, cardId]);
	return useLoad(load);
}
