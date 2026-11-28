/**
 * IPC of « Interroger le tableau » (docs/architecture/board-ask.md): the
 * renderer sends a project id, a question and the conversation so far; the
 * tickets are read here, from the project's own cards, never from the
 * renderer. « Vérifier une idée » (lot 3) sends a project id and the feature
 * planned, and gets what the board already holds of it. Both read the other
 * sources of the project too (roadmap, ideas, merged changes: `sources.ts`).
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	BoardAskRequest,
	BoardAskResult,
	BoardAskTurn,
	BoardIdeaRequest,
	BoardIdeaResult,
	IPCResult,
} from "../../shared/types";
import { BOARD_ASK_LIMITS } from "../../shared/types/board-ask";
import { getAppLanguage } from "../app-language";
import { askBoard, type CompletionFn } from "../board-ask/board-ask-service";
import { checkIdea } from "../board-ask/idea-check";
import { readBoardSources, readBoardSourcesSetting } from "../board-ask/sources";
import {
	createSemanticRankings,
	createSemanticSearch,
	readSemanticMode,
	type SemanticFn,
	type SemanticManyFn,
} from "../board-ask/semantic-search";
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

/** The idea to check, revalidated (S6), or the reason it is refused. */
export function parseBoardIdeaRequest(raw: unknown): BoardIdeaRequest | string {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "Invalid request";
	const { projectId, idea } = raw as Record<string, unknown>;
	if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > MAX_ID) {
		return "Invalid project id";
	}
	if (typeof idea !== "string" || !idea.trim() || idea.length > BOARD_ASK_LIMITS.idea) return "Invalid idea";
	return { projectId, idea: idea.trim() };
}

/** The local project a request names, or why it is refused. */
function localProject(projectId: string) {
	// A server board is asked on the server (a later lot): its cards are not read here.
	if (getServerProject(projectId)) return "server_project";
	return projectStore.getProject(projectId) ?? "Unknown project";
}

function completionIn(projectDir: string): CompletionFn {
	return (prompt, systemPrompt, label) =>
		runOneShotLLM({
			prompt,
			systemPrompt,
			projectDir,
			timeoutMs: COMPLETION_TIMEOUT_MS,
			debugLabel: label,
		});
}

export async function handleBoardAsk(
	raw: unknown,
	complete?: CompletionFn,
	semantic?: SemanticFn | null,
): Promise<IPCResult<BoardAskResult>> {
	const request = parseBoardAskRequest(raw);
	if (typeof request === "string") return { success: false, error: request };
	const project = localProject(request.projectId);
	if (typeof project === "string") return { success: false, error: project };

	const run = complete ?? completionIn(project.path);
	const tasks = projectStore.getTasks(project.id);
	const data = await askBoard({
		tasks,
		sources: await readBoardSources(project.path, tasks, readBoardSourcesSetting()),
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

export async function handleBoardIdea(
	raw: unknown,
	complete?: CompletionFn,
	semantic?: SemanticManyFn | null,
): Promise<IPCResult<BoardIdeaResult>> {
	const request = parseBoardIdeaRequest(raw);
	if (typeof request === "string") return { success: false, error: request };
	const project = localProject(request.projectId);
	if (typeof project === "string") return { success: false, error: project };

	const tasks = projectStore.getTasks(project.id);
	const data = await checkIdea({
		tasks,
		sources: await readBoardSources(project.path, tasks, readBoardSourcesSetting()),
		idea: request.idea,
		appLanguage: getAppLanguage(),
		complete: complete ?? completionIn(project.path),
		semantic:
			semantic === undefined
				? createSemanticRankings({ projectDir: project.path, mode: readSemanticMode() })
				: (semantic ?? undefined),
	});
	return { success: true, data };
}

export function registerBoardAskHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.BOARD_ASK, (_, request: unknown) => handleBoardAsk(request));
	ipcMain.handle(IPC_CHANNELS.BOARD_ASK_CHECK_IDEA, (_, request: unknown) => handleBoardIdea(request));
}
