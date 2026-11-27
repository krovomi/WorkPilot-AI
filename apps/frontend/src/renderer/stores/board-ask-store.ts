/**
 * « Interroger le tableau » (docs/architecture/board-ask.md): the panel and
 * one conversation per project. Kept in memory only: a question and its
 * answer are never written to disk, and closing the app forgets them.
 */

import { create } from "zustand";
import type { BoardAskResult, BoardAskTurn } from "../../shared/types";
import { BOARD_ASK_LIMITS } from "../../shared/types/board-ask";

export interface BoardAskEntry {
	id: number;
	question: string;
	status: "pending" | "done" | "error";
	result?: BoardAskResult;
	/** `server_project`, or the error the main process gave. */
	error?: string;
}

interface BoardAskState {
	open: boolean;
	conversations: Record<string, BoardAskEntry[]>;
	setOpen: (open: boolean) => void;
	ask: (projectId: string, question: string) => Promise<void>;
	clear: (projectId: string) => void;
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

export const useBoardAskStore = create<BoardAskState>((set, get) => ({
	open: false,
	conversations: {},
	setOpen: (open) => set({ open }),
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
					error: error instanceof Error ? error.message : String(error),
				}),
			}));
		}
	},
	clear: (projectId) =>
		set((state) => {
			const { [projectId]: _dropped, ...rest } = state.conversations;
			return { conversations: rest };
		}),
}));
