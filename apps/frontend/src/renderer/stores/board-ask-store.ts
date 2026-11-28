/**
 * « Interroger le tableau » (docs/architecture/board-ask.md): the panel and
 * one conversation per project, and the last idea checked per project
 * (« Vérifier une idée »). Kept in memory only: a question, an idea and their
 * answers are never written to disk, and closing the app forgets them.
 */

import { create } from "zustand";
import type { BoardAskResult, BoardAskTurn, BoardIdeaResult } from "../../shared/types";
import { BOARD_ASK_LIMITS } from "../../shared/types/board-ask";

export interface BoardAskEntry {
	id: number;
	question: string;
	status: "pending" | "done" | "error";
	result?: BoardAskResult;
	/** `server_unreachable`, or the error the main process gave. */
	error?: string;
}

export type BoardAskTab = "ask" | "idea";

export interface BoardIdeaCheck {
	idea: string;
	status: "pending" | "done" | "error";
	result?: BoardIdeaResult;
	/** `server_unreachable`, or the error the main process gave. */
	error?: string;
	/** The card created with what is missing, once it is. */
	createdTaskId?: string;
}

interface BoardAskState {
	open: boolean;
	tab: BoardAskTab;
	conversations: Record<string, BoardAskEntry[]>;
	ideas: Record<string, BoardIdeaCheck>;
	setOpen: (open: boolean) => void;
	setTab: (tab: BoardAskTab) => void;
	ask: (projectId: string, question: string) => Promise<void>;
	clear: (projectId: string) => void;
	checkIdea: (projectId: string, idea: string) => Promise<void>;
	markIdeaCard: (projectId: string, taskId: string) => void;
	clearIdea: (projectId: string) => void;
}

let nextId = 1;

/** What an earlier turn told the person, for the model to read a follow-up. */
export function turnAnswer(result: BoardAskResult): string {
	if (result.answer) return result.answer;
	return result.matches.map((m, i) => `[${i + 1}] ${m.title}`).join("\n");
}

function historyOf(entries: readonly BoardAskEntry[]): BoardAskTurn[] {
	return entries
		.filter((e): e is BoardAskEntry & { result: BoardAskResult } => e.status === "done" && Boolean(e.result))
		.slice(-BOARD_ASK_LIMITS.historyTurns)
		.map((e) => ({
			question: e.question.slice(0, BOARD_ASK_LIMITS.turnText),
			answer: turnAnswer(e.result).slice(0, BOARD_ASK_LIMITS.turnText),
		}));
}

function update(
	conversations: Record<string, BoardAskEntry[]>,
	projectId: string,
	id: number,
	patch: Partial<BoardAskEntry>,
): Record<string, BoardAskEntry[]> {
	const entries = conversations[projectId];
	if (!entries) return conversations;
	return { ...conversations, [projectId]: entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const useBoardAskStore = create<BoardAskState>((set, get) => ({
	open: false,
	tab: "ask",
	conversations: {},
	ideas: {},
	setOpen: (open) => set({ open }),
	setTab: (tab) => set({ tab }),
	ask: async (projectId, raw) => {
		const question = raw.trim().slice(0, BOARD_ASK_LIMITS.question);
		const entries = get().conversations[projectId] ?? [];
		if (!question || entries.some((e) => e.status === "pending")) return;
		const id = nextId++;
		const history = historyOf(entries);
		set((state) => ({
			conversations: {
				...state.conversations,
				[projectId]: [...entries, { id, question, status: "pending" }],
			},
		}));
		try {
			const response = await globalThis.electronAPI.askBoard({ projectId, question, history });
			set((state) => ({
				conversations: update(
					state.conversations,
					projectId,
					id,
					response.success && response.data
						? { status: "done", result: response.data }
						: { status: "error", error: response.error ?? "unknown" },
				),
			}));
		} catch (error) {
			set((state) => ({
				conversations: update(state.conversations, projectId, id, {
					status: "error",
					error: errorText(error),
				}),
			}));
		}
	},
	clear: (projectId) =>
		set((state) => {
			const { [projectId]: _dropped, ...rest } = state.conversations;
			return { conversations: rest };
		}),
	checkIdea: async (projectId, raw) => {
		const idea = raw.trim().slice(0, BOARD_ASK_LIMITS.idea);
		if (!idea || get().ideas[projectId]?.status === "pending") return;
		const settle = (patch: Partial<BoardIdeaCheck>) =>
			set((state) => {
				const current = state.ideas[projectId];
				// A check cleared or replaced while it ran is not overwritten.
				if (current?.idea !== idea || current.status !== "pending") return state;
				return { ideas: { ...state.ideas, [projectId]: { ...current, ...patch } } };
			});
		set((state) => ({ ideas: { ...state.ideas, [projectId]: { idea, status: "pending" } } }));
		try {
			const response = await globalThis.electronAPI.checkBoardIdea({ projectId, idea });
			settle(
				response.success && response.data
					? { status: "done", result: response.data }
					: { status: "error", error: response.error ?? "unknown" },
			);
		} catch (error) {
			settle({ status: "error", error: errorText(error) });
		}
	},
	markIdeaCard: (projectId, taskId) =>
		set((state) => {
			const current = state.ideas[projectId];
			if (!current) return state;
			return { ideas: { ...state.ideas, [projectId]: { ...current, createdTaskId: taskId } } };
		}),
	clearIdea: (projectId) =>
		set((state) => {
			const { [projectId]: _dropped, ...rest } = state.ideas;
			return { ideas: rest };
		}),
}));
