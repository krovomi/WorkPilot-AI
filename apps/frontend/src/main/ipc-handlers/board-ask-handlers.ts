/**
 * IPC of « Interroger le tableau » (docs/architecture/board-ask.md): the
 * renderer sends a project id, a question and the conversation so far; the
 * tickets are read here, from the project's own cards, never from the
 * renderer.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { BoardAskRequest, BoardAskResult, BoardAskTurn, IPCResult } from "../../shared/types";
import { BOARD_ASK_LIMITS } from "../../shared/types/board-ask";
import { getAppLanguage } from "../app-language";
import { askBoard, type CompletionFn } from "../board-ask/board-ask-service";
import { createSemanticSearch, readSemanticMode, type SemanticFn } from "../board-ask/semantic-search";
import { runOneShotLLM } from "../oneshot-llm";
import { projectStore } from "../project-store";
import { getServerProject } from "../server-projects";

const COMPLETION_TIMEOUT_MS = 60_000;
const MAX_ID = 200;
/** History entries accepted at all; only the last few are read. */
const MAX_HISTORY = 20;

/** The request, revalidated (S6), or the reason it is refused. */
export function parseBoardAskRequest(raw: unknown): BoardAskRequest | string {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "Invalid request";
	const { projectId, question, history } = raw as Record<string, unknown>;
	if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > MAX_ID) {
		return "Invalid project id";
	}
	if (typeof question !== "string" || !question.trim() || question.length > BOARD_ASK_LIMITS.question) {
		return "Invalid question";
	}
	if (history !== undefined && (!Array.isArray(history) || history.length > MAX_HISTORY)) {
		return "Invalid conversation";
	}
	const turns: BoardAskTurn[] = [];
	for (const turn of (history as unknown[] | undefined) ?? []) {
		if (typeof turn !== "object" || turn === null) return "Invalid conversation";
		const { question: q, answer: a } = turn as Record<string, unknown>;
		if (
			typeof q !== "string" ||
			typeof a !== "string" ||
			q.length > BOARD_ASK_LIMITS.turnText ||
			a.length > BOARD_ASK_LIMITS.turnText
		) {
			return "Invalid conversation";
		}
		turns.push({ question: q, answer: a });
	}
	return { projectId, question: question.trim(), history: turns.slice(-BOARD_ASK_LIMITS.historyTurns) };
}

export async function handleBoardAsk(
	raw: unknown,
	complete?: CompletionFn,
	semantic?: SemanticFn | null,
): Promise<IPCResult<BoardAskResult>> {
	const request = parseBoardAskRequest(raw);
	if (typeof request === "string") return { success: false, error: request };
	// A server board is asked on the server (a later lot): its cards are not read here.
	if (getServerProject(request.projectId)) return { success: false, error: "server_project" };
	const project = projectStore.getProject(request.projectId);
	if (!project) return { success: false, error: "Unknown project" };

	const run: CompletionFn =
		complete ??
		((prompt, systemPrompt, label) =>
			runOneShotLLM({
				prompt,
				systemPrompt,
				projectDir: project.path,
				timeoutMs: COMPLETION_TIMEOUT_MS,
				debugLabel: label,
			}));
	const data = await askBoard({
		tasks: projectStore.getTasks(project.id),
		question: request.question,
		history: request.history,
		appLanguage: getAppLanguage(),
		complete: run,
		semantic:
			semantic === undefined
				? createSemanticSearch({ projectDir: project.path, mode: readSemanticMode() })
				: (semantic ?? undefined),
	});
	return { success: true, data };
}

export function registerBoardAskHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.BOARD_ASK, (_, request: unknown) => handleBoardAsk(request));
}
