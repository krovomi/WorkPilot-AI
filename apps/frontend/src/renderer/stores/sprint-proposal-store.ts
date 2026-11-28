/**
 * « Proposer le sprint » in the planning view: the settings asked for, the
 * wait while the main process composes (`proposeSprint`), then the proposal
 * the person trims or completes before adding it. Nothing moves until they
 * do, through the planning view's own move (so « Undo » takes it back).
 *
 * The proposal outlives the view: closing it while the model works keeps the
 * answer for when it opens again on the same sprint. A newer ask, another
 * sprint or another project drops an older answer.
 *
 * Design: docs/architecture/sprint-proposal.md.
 */
import { create } from "zustand";
import type { SprintProposal, SprintProposalVariant } from "../../shared/types";
import { useSprintStore } from "./sprint-store";

export type ProposalPhase = "idle" | "settings" | "thinking" | "ready" | "failed";

export interface ProposalAsk {
	variant: SprintProposalVariant;
	/** A goal for this proposal; empty, the sprint's own. */
	goal: string;
	/** Points to fill up to; null, the sprint's capacity. */
	capacity: number | null;
}

interface SprintProposalState {
	sprintId: string | null;
	projectId: string | null;
	phase: ProposalPhase;
	ask: ProposalAsk;
	proposal: SprintProposal | null;
	/** Proposed cards the person took out. */
	removed: ReadonlySet<string>;
	/** Cards from below the line the person put in. */
	added: readonly string[];
	error: string | null;
	/** Opens the settings for a sprint, prefilled with the last ask. */
	openSettings: (sprintId: string, ask?: Partial<ProposalAsk>) => void;
	/** Asks for a proposal; the answer replaces the one shown. */
	propose: (sprintId: string, ask?: Partial<ProposalAsk>) => Promise<void>;
	/** Takes a proposed card out, with the cards proposed only for it; again puts them back. */
	toggleRemoved: (taskId: string) => void;
	/** Puts a card from below the line in, or takes it out again. */
	toggleAdded: (taskId: string) => void;
	dismiss: () => void;
}

const DEFAULT_ASK: ProposalAsk = { variant: "balanced", goal: "", capacity: null };
const NOTHING: ReadonlySet<string> = new Set();

/** Each ask gets a number; only the latest one's answer is kept. */
let asked = 0;

export const useSprintProposalStore = create<SprintProposalState>((set, get) => ({
	sprintId: null,
	projectId: null,
	phase: "idle",
	ask: DEFAULT_ASK,
	proposal: null,
	removed: NOTHING,
	added: [],
	error: null,

	openSettings: (sprintId, ask) => {
		asked++;
		const projectId = useSprintStore.getState().projectId;
		const same = get().sprintId === sprintId && get().projectId === projectId;
		set({
			sprintId,
			projectId,
			phase: "settings",
			ask: { ...(same ? get().ask : DEFAULT_ASK), ...ask },
			proposal: null,
			removed: NOTHING,
			added: [],
			error: null,
		});
	},

	propose: async (sprintId, ask) => {
		const projectId = useSprintStore.getState().projectId;
		const next = { ...get().ask, ...ask };
		const ticket = ++asked;
		set({ sprintId, projectId, phase: "thinking", ask: next, proposal: null, removed: NOTHING, added: [], error: null });
		if (!projectId) {
			set({ phase: "failed", error: "no_project" });
			return;
		}
		let phase: ProposalPhase = "failed";
		let proposal: SprintProposal | null = null;
		let error: string | null = null;
		try {
			const result = await globalThis.electronAPI?.proposeSprint?.({
				projectId,
				sprintId,
				variant: next.variant,
				...(next.goal.trim() ? { goal: next.goal.trim() } : {}),
				...(next.capacity ? { capacity: next.capacity } : {}),
			});
			if (result?.success && result.data) {
				phase = "ready";
				proposal = result.data;
			} else {
				error = result?.error ?? "unavailable";
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "unknown";
		}
		if (ticket !== asked) return;
		set({ phase, proposal, error });
	},

	toggleRemoved: (taskId) => {
		const { proposal, removed } = get();
		if (!proposal) return;
		const next = new Set(removed);
		const group = [taskId, ...proposal.picks.filter((pick) => pick.dependencyOf === taskId).map((pick) => pick.taskId)];
		if (next.has(taskId)) for (const id of group) next.delete(id);
		else for (const id of group) next.add(id);
		set({ removed: next });
	},

	toggleAdded: (taskId) => {
		const { proposal, added } = get();
		if (!proposal?.below.some((item) => item.taskId === taskId)) return;
		set({ added: added.includes(taskId) ? added.filter((id) => id !== taskId) : [...added, taskId] });
	},

	dismiss: () => {
		asked++;
		set({ sprintId: null, phase: "idle", proposal: null, removed: NOTHING, added: [], error: null });
	},
}));

/** The cards the proposal now offers, in reading order: the picks kept, then what was put in from below. */
export function offeredIds(proposal: SprintProposal | null, removed: ReadonlySet<string>, added: readonly string[]): string[] {
	if (!proposal) return [];
	return [...proposal.picks.filter((pick) => !removed.has(pick.taskId)).map((pick) => pick.taskId), ...added];
}
