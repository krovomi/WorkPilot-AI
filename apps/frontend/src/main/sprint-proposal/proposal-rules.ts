/**
 * The rules of « Proposer le sprint », without a model: which cards may be
 * offered, in which order, and how they fill a sprint up to its capacity.
 * They answer alone when no model does, and they check what a model chose:
 * a card it names is offered only if the rules know it, after what it waits
 * on, and only while the capacity holds.
 *
 * A candidate is a plannable backlog card (no sprint, not done, abandoned
 * or archived) with points. Its blockers (`metadata.blockedBy`) that are
 * neither done nor in the sprint come with it, first, when they are
 * candidates too; a card that waits on anything else (a card of another
 * sprint, one without an estimate) is not offered and is listed as blocked.
 *
 * Design: docs/architecture/sprint-proposal.md.
 */

import type {
	SprintPickReason,
	SprintProposal,
	SprintProposalBelow,
	SprintProposalPick,
	SprintProposalVariant,
	Task,
	TaskPriority,
} from "../../shared/types";
import { SPRINT_PROPOSAL_LIMITS } from "../../shared/types/sprint-proposal";
import { isTaskDone, taskPoints } from "../../shared/utils/sprints";

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { urgent: 40, high: 25, medium: 10, low: 0 };
const NO_PRIORITY_WEIGHT = 5;
const BUG_WEIGHT = 15;
const UNBLOCKS_WEIGHT = 8;
const GOAL_WEIGHT = 12;
const AGE_DAYS_CAP = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** « Plus prudent »: this share of the capacity. */
export const CAREFUL_SHARE = 0.8;
/** Words of a goal shorter than this say nothing about a card. */
const MIN_GOAL_WORD = 4;

export interface Candidate {
	task: Task;
	points: number;
	score: number;
	/** Open cards that wait on this one. */
	unblocks: number;
	/** Whether its words meet the sprint's goal. */
	goal: boolean;
	/** Ids of the cards it waits on that are neither done nor in the sprint. */
	waitsOn: string[];
}

export interface RuleInput {
	tasks: readonly Task[];
	sprintId: string;
	capacity: number;
	variant: SprintProposalVariant;
	goal?: string;
	now: number;
}

function fold(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
}

/** The words of a goal worth looking for in a card. */
export function goalWords(goal: string | undefined): string[] {
	if (!goal) return [];
	return [...new Set(fold(goal).split(/[^\p{L}\p{N}]+/u))].filter((word) => word.length >= MIN_GOAL_WORD);
}

function find(tasks: readonly Task[], ref: string): Task | undefined {
	return tasks.find((task) => task.id === ref || task.specId === ref);
}

function plannable(task: Task): boolean {
	return !isTaskDone(task) && !task.metadata?.abandoned && !task.metadata?.archivedAt;
}

function ageDays(task: Task, now: number): number {
	const at = new Date(task.createdAt as unknown as string | Date).getTime();
	return Number.isNaN(at) ? 0 : Math.max(0, (now - at) / DAY_MS);
}

/** The cards a card waits on that are still open and not in the sprint. */
function openBlockers(task: Task, tasks: readonly Task[], sprintId: string): Task[] {
	const blockers: Task[] = [];
	for (const ref of task.metadata?.blockedBy ?? []) {
		const blocker = find(tasks, ref);
		if (!blocker || blocker.id === task.id || isTaskDone(blocker) || blocker.metadata?.abandoned) continue;
		if (blocker.metadata?.sprintId === sprintId) continue;
		if (!blockers.includes(blocker)) blockers.push(blocker);
	}
	return blockers;
}

export interface Pool {
	/** Ranked best first. */
	candidates: Candidate[];
	unestimated: string[];
}

/** The candidates, ranked, and the plannable cards left out for want of points. */
export function rankCandidates(input: RuleInput): Pool {
	const { tasks, sprintId, variant, now } = input;
	const words = goalWords(input.goal);
	const open = tasks.filter((task) => plannable(task));
	const unblocking = new Map<string, number>();
	for (const task of open) {
		for (const blocker of openBlockers(task, tasks, "")) {
			unblocking.set(blocker.id, (unblocking.get(blocker.id) ?? 0) + 1);
		}
	}
	const candidates: Candidate[] = [];
	const unestimated: string[] = [];
	for (const task of open) {
		if (task.metadata?.sprintId) continue;
		const points = taskPoints(task);
		if (points === 0) {
			unestimated.push(task.id);
			continue;
		}
		const priority = task.metadata?.priority;
		const bug = task.metadata?.category === "bug_fix";
		const text = fold(`${task.title} ${task.description ?? ""}`);
		const goal = words.some((word) => text.includes(word));
		const unblocks = unblocking.get(task.id) ?? 0;
		let score = priority ? PRIORITY_WEIGHT[priority] : NO_PRIORITY_WEIGHT;
		score += bug ? BUG_WEIGHT * (variant === "bugs" ? 3 : 1) : 0;
		score += unblocks * UNBLOCKS_WEIGHT;
		score += goal ? GOAL_WEIGHT * (variant === "goal" ? 3 : 1) : 0;
		score += Math.min(AGE_DAYS_CAP, ageDays(task, now)) / 3;
		candidates.push({
			task,
			points,
			score,
			unblocks,
			goal,
			waitsOn: openBlockers(task, tasks, sprintId).map((blocker) => blocker.id),
		});
	}
	candidates.sort(
		(a, b) => b.score - a.score || ageDays(b.task, now) - ageDays(a.task, now) || a.task.title.localeCompare(b.task.title),
	);
	return { candidates, unestimated };
}

/** The points a proposal fills up to: the capacity, less for « Plus prudent ». */
export function targetPoints(capacity: number, variant: SprintProposalVariant): number {
	return variant === "careful" ? Math.max(1, Math.round(capacity * CAREFUL_SHARE)) : capacity;
}

/** The rules' reason for a card, the first that holds. */
export function reasonOf(candidate: Candidate): SprintPickReason {
	const priority = candidate.task.metadata?.priority;
	if (priority === "urgent") return "urgent";
	if (candidate.task.metadata?.category === "bug_fix") return "bug";
	if (candidate.unblocks > 0) return "unblocks";
	if (candidate.goal) return "goal";
	if (priority === "high") return "high";
	return "fits";
}

export interface Filled {
	picks: SprintProposalPick[];
	points: number;
	below: SprintProposalBelow[];
	blocked: string[];
}

/**
 * Fills `room` points with the cards in `order` (ids of candidates; others
 * are ignored), each with the candidates it waits on first. A card whose
 * wait leads outside the candidates is blocked; one that would overflow,
 * with what it waits on, goes below the line. `runnersUp` are only weighed
 * for that line: a card the model left out is never added, but the best of
 * them that would not fit are still shown below it.
 */
export function fill(
	order: readonly string[],
	candidates: readonly Candidate[],
	room: number,
	committed: number,
	notes: ReadonlyMap<string, string> = new Map(),
	runnersUp: readonly string[] = [],
): Filled {
	const byId = new Map(candidates.map((candidate) => [candidate.task.id, candidate]));
	const chosen = new Set<string>();
	const picks: SprintProposalPick[] = [];
	const below: SprintProposalBelow[] = [];
	const blocked = new Set<string>();
	let points = 0;

	const costOf = (chain: readonly string[]) =>
		chain.reduce((sum, item) => sum + (byId.get(item) as Candidate).points, 0);

	/** The card and what it waits on, blockers first; null when one is not a candidate. */
	const closure = (id: string, seen: Set<string>): string[] | null => {
		if (chosen.has(id) || seen.has(id)) return [];
		const candidate = byId.get(id);
		if (!candidate) return null;
		seen.add(id);
		const chain: string[] = [];
		for (const blocker of candidate.waitsOn) {
			const part = closure(blocker, seen);
			if (part === null) return null;
			chain.push(...part);
		}
		chain.push(id);
		return chain;
	};

	for (const id of order) {
		if (chosen.has(id) || !byId.has(id)) continue;
		const chain = closure(id, new Set());
		if (chain === null) {
			blocked.add(id);
			continue;
		}
		const cost = costOf(chain);
		if (points + cost > room) {
			if (below.length < SPRINT_PROPOSAL_LIMITS.below && !below.some((item) => item.taskId === id)) {
				below.push({ taskId: id, points: cost, total: committed + points + cost });
			}
			continue;
		}
		for (const item of chain) {
			const candidate = byId.get(item) as Candidate;
			chosen.add(item);
			const pick: SprintProposalPick = {
				taskId: item,
				points: candidate.points,
				reason: item === id ? reasonOf(candidate) : "dependency",
			};
			if (item !== id) pick.dependencyOf = id;
			if (pick.reason === "unblocks") pick.unblocks = candidate.unblocks;
			const note = notes.get(item);
			if (note) pick.note = note;
			picks.push(pick);
		}
		points += cost;
	}
	for (const id of runnersUp) {
		if (below.length >= SPRINT_PROPOSAL_LIMITS.below) break;
		if (chosen.has(id) || below.some((item) => item.taskId === id)) continue;
		const chain = closure(id, new Set());
		if (chain === null) continue;
		const cost = costOf(chain);
		if (points + cost > room) below.push({ taskId: id, points: cost, total: committed + points + cost });
	}
	return { picks, points, below, blocked: [...blocked] };
}

/** The proposal of the rules alone: the ranked candidates, in order, up to the room. */
export function proposeByRules(input: RuleInput, committed: number): SprintProposal {
	const pool = rankCandidates(input);
	const room = Math.max(0, targetPoints(input.capacity, input.variant) - committed);
	const filled = fill(
		pool.candidates.map((candidate) => candidate.task.id),
		pool.candidates,
		room,
		committed,
	);
	return {
		sprintId: input.sprintId,
		capacity: targetPoints(input.capacity, input.variant),
		committed,
		picks: filled.picks,
		points: filled.points,
		below: filled.below,
		unestimated: pool.unestimated,
		blocked: filled.blocked,
		mode: "rules",
		variant: input.variant,
	};
}
