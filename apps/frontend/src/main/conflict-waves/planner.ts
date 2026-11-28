/**
 * Execution waves across specs (issue #358). Pure and deterministic: no I/O,
 * no clock, no model. The handler gathers the inputs (plans, worktree
 * changes, the project's max parallel tasks) and stamps the result.
 *
 * 1. Footprint of each spec = files its plan declares ∪ files its worktree
 *    already changed (any language: the scorer weighs files by role). With
 *    `coChanges`, files the history changes together (one in each spec) add
 *    to the pair's score: fragile zones. With each spec's `code`, a file of
 *    one importing a module the other edits, or using a symbol the other
 *    removes, adds too: code links (`code-links.ts`).
 * 2. Conflict graph: an edge between two specs whose score is above the
 *    tolerance, whose test merge conflicted (`mergeChecks`, run by the
 *    service on pairs a previous pass put in one wave), or one of which has
 *    no known footprint (policy `isolate`).
 * 3. Dependencies (`metadata.blockedBy`) are precedence constraints: a spec
 *    goes in a later wave than its blockers. A cycle cannot be planned
 *    without a human: its specs, and those waiting on them, are excluded.
 * 4. Greedy colouring: specs by dependency depth, planned before unplanned
 *    (what is known runs first; a plan written meanwhile is picked up when
 *    the next wave is planned again), then by weighted conflict degree (most
 *    constrained first), priority, age and id; each goes in the
 *    feasible wave (no edge with a member, room under the max parallelism)
 *    that adds the least residual risk, the earliest on a tie.
 * 5. Inside a wave, the spec that shares most with later waves merges first:
 *    the waves after it then start from a base that already holds it.
 */

import type {
	ExecutionWave,
	UnplannedPolicy,
	WaveDrift,
	WaveExclusion,
	WaveMergeVerdict,
	WavePairRisk,
	WavePlanTask,
	WaveRunningConflict,
} from "../../shared/types/conflict-waves";
import type { TaskStatus } from "../../shared/types/task";
import { codeLinks, MAX_CODE_WEIGHT, type SpecCode } from "./code-links";
import {
	buildFootprint,
	type CoChangeIndex,
	type Footprint,
	fragileLinks,
	MAX_FRAGILE_WEIGHT,
	riskLevel,
	scorePair,
} from "./scorer";

export interface PlannerTask {
	id: string;
	title: string;
	status: TaskStatus;
	/** 0 when unset, 4 for urgent (same scale as the queue). */
	priorityWeight: number;
	createdAtMs: number;
	blockedBy: readonly string[];
	/** Files the implementation plan declares. */
	plannedFiles: readonly string[];
	/** Files the worktree changed, or null when it has none. */
	actualFiles: readonly string[] | null;
	/** Its code, read for code links; absent when they are off or it was not read. */
	code?: SpecCode | null;
}

export interface PlannerOptions {
	maxParallel: number;
	tolerance: number;
	unplannedPolicy: UnplannedPolicy;
	driftThreshold: number;
	/** Test merges already run, by `pairKey`: a conflict is an edge. */
	mergeChecks?: ReadonlyMap<string, MergeOutcome>;
	/** Files the history changes together (fragile zones); absent when off. */
	coChanges?: CoChangeIndex;
}

/** What a test merge of two worktrees said, and the files left in conflict. */
export interface MergeOutcome {
	verdict: WaveMergeVerdict;
	files: readonly string[];
}

export interface PlannerResult {
	waves: ExecutionWave[];
	order: string[];
	tasks: WavePlanTask[];
	pairs: WavePairRisk[];
	cycles: string[][];
	excluded: WaveExclusion[];
	drift: WaveDrift[];
	runningConflicts: WaveRunningConflict[];
	totalRisk: number;
	residualRisk: number;
}

export const MAX_LISTED_FILES = 20;

interface Node {
	task: PlannerTask;
	footprint: Footprint;
	planned: boolean;
}

function toNode(task: PlannerTask): Node {
	const footprint = buildFootprint(task.plannedFiles, task.actualFiles ?? []);
	return { task, footprint, planned: footprint.size > 0 };
}

/** The same key for (a, b) and (b, a). */
export function pairKey(a: string, b: string): string {
	return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Stable order before anything else: priority, age, id. */
function compareBase(a: PlannerTask, b: PlannerTask): number {
	return (
		b.priorityWeight - a.priorityWeight ||
		a.createdAtMs - b.createdAtMs ||
		// Ids are unique: two tasks never compare equal.
		(a.id < b.id ? -1 : 1)
	);
}

/** Tarjan's strongly connected components; returns those of size > 1. */
function findCycles(ids: readonly string[], edges: Map<string, string[]>): string[][] {
	let counter = 0;
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const cycles: string[][] = [];

	const visit = (v: string): void => {
		index.set(v, counter);
		low.set(v, counter);
		counter++;
		stack.push(v);
		onStack.add(v);
		for (const w of edges.get(v) as string[]) {
			if (!index.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
			}
		}
		if (low.get(v) === index.get(v)) {
			const component: string[] = [];
			let w: string;
			do {
				w = stack.pop() as string;
				onStack.delete(w);
				component.push(w);
			} while (w !== v);
			if (component.length > 1) cycles.push(component.sort());
		}
	};

	for (const id of ids) if (!index.has(id)) visit(id);
	return cycles.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function computeDrift(node: Node, threshold: number): WaveDrift | null {
	const { task } = node;
	if (!task.actualFiles || task.plannedFiles.length === 0) return null;
	const planned = buildFootprint(task.plannedFiles);
	const actual = buildFootprint(task.actualFiles);
	const extra = [...actual].filter(([n]) => !planned.has(n)).map(([, display]) => display);
	if (extra.length === 0 || extra.length < threshold) return null;
	extra.sort((a, b) => a.localeCompare(b));
	return {
		taskId: task.id,
		extraCount: extra.length,
		extraFiles: extra.slice(0, MAX_LISTED_FILES),
	};
}

export function planExecutionWaves(
	candidates: readonly PlannerTask[],
	running: readonly PlannerTask[],
	options: PlannerOptions,
): PlannerResult {
	const maxParallel = Math.max(1, Math.floor(options.maxParallel));
	const tolerance = Math.max(0, options.tolerance);
	const isolateUnplanned = options.unplannedPolicy === "isolate";

	/** Shared files by weight, plus the fragile and code links between the two, each capped. */
	const pairScore = (a: Node, b: Node) => {
		const { score, shared } = scorePair(a.footprint, b.footprint);
		const links = options.coChanges ? fragileLinks(a.footprint, b.footprint, options.coChanges) : [];
		const code = codeLinks(a.footprint, a.task.code, b.footprint, b.task.code);
		const codeCount = code.imports.length + code.symbols.length;
		return {
			score:
				score +
				Math.min(links.length, MAX_FRAGILE_WEIGHT) +
				Math.min(codeCount, MAX_CODE_WEIGHT),
			shared,
			links,
			code,
		};
	};

	const sorted = [...candidates].sort(compareBase);
	const nodes = new Map(sorted.map((t) => [t.id, toNode(t)]));
	const ids = sorted.map((t) => t.id);

	// Pair scores and the conflict graph.
	const pairs: WavePairRisk[] = [];
	const scores = new Map<string, number>();
	const blocking = new Set<string>();
	const degree = new Map<string, number>(ids.map((id) => [id, 0]));
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			const a = nodes.get(ids[i]) as Node;
			const b = nodes.get(ids[j]) as Node;
			const unknown = !a.planned || !b.planned;
			const { score, shared, links, code } = pairScore(a, b);
			const key = pairKey(a.task.id, b.task.id);
			const merge = options.mergeChecks?.get(key);
			const conflicted = merge?.verdict === "conflict";
			const isBlocking = unknown ? isolateUnplanned : score > tolerance || conflicted;
			scores.set(key, score);
			if (isBlocking) blocking.add(key);
			if (score > 0 || (unknown && isolateUnplanned) || conflicted) {
				pairs.push({
					a: a.task.id,
					b: b.task.id,
					score,
					level: riskLevel(score),
					sharedFiles: shared.slice(0, MAX_LISTED_FILES),
					unknown,
					blocking: isBlocking,
					...(merge && {
						mergeCheck: merge.verdict,
						conflictFiles: merge.files.slice(0, MAX_LISTED_FILES),
					}),
					...(links.length > 0 ? { fragileLinks: links.slice(0, MAX_LISTED_FILES) } : {}),
					...(code.imports.length > 0
						? { importLinks: code.imports.slice(0, MAX_LISTED_FILES) }
						: {}),
					...(code.symbols.length > 0
						? { symbolLinks: code.symbols.slice(0, MAX_LISTED_FILES) }
						: {}),
				});
				// An unknown pair weighs one: enough to order, not to dominate.
				const weight = score > 0 ? score : 1;
				degree.set(a.task.id, (degree.get(a.task.id) as number) + weight);
				degree.set(b.task.id, (degree.get(b.task.id) as number) + weight);
			}
		}
	}
	pairs.sort((x, y) => y.score - x.score || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)));

	// Dependencies inside the planned set: task -> its blockers.
	const blockers = new Map<string, string[]>();
	for (const id of ids) {
		const own = (nodes.get(id) as Node).task.blockedBy;
		blockers.set(
			id,
			[...new Set(own)].filter((b) => b !== id && nodes.has(b)).sort(),
		);
	}
	// Every id of the plan has an entry in both maps.
	const blockersOf = (id: string): string[] => blockers.get(id) as string[];
	const scoreOf = (x: string, y: string): number => scores.get(pairKey(x, y)) as number;
	const cycles = findCycles(ids, blockers);
	const excluded: WaveExclusion[] = [];
	const out = new Set<string>();
	for (const cycle of cycles) {
		for (const id of cycle) {
			out.add(id);
			excluded.push({ taskId: id, reason: "cycle" });
		}
	}
	// Whoever waits, directly or not, on a spec of a cycle waits for ever.
	let grew = true;
	while (grew) {
		grew = false;
		for (const id of ids) {
			if (out.has(id)) continue;
			if (blockersOf(id).some((b) => out.has(b))) {
				out.add(id);
				excluded.push({ taskId: id, reason: "blocked_by_cycle" });
				grew = true;
			}
		}
	}
	excluded.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
	const plannable = ids.filter((id) => !out.has(id));
	let totalRisk = 0;
	for (let i = 0; i < plannable.length; i++) {
		for (let j = i + 1; j < plannable.length; j++) {
			totalRisk += scoreOf(plannable[i], plannable[j]);
		}
	}

	// Dependency depth (the graph is acyclic once cycles are out).
	const depth = new Map<string, number>();
	const depthOf = (id: string): number => {
		const known = depth.get(id);
		if (known !== undefined) return known;
		const d = Math.max(-1, ...blockersOf(id).map(depthOf)) + 1;
		depth.set(id, d);
		return d;
	};
	for (const id of plannable) depthOf(id);

	const colouringOrder = [...plannable].sort(
		(a, b) =>
			(depth.get(a) as number) - (depth.get(b) as number) ||
			Number((nodes.get(b) as Node).planned) - Number((nodes.get(a) as Node).planned) ||
			(degree.get(b) as number) - (degree.get(a) as number) ||
			compareBase((nodes.get(a) as Node).task, (nodes.get(b) as Node).task),
	);

	const members: string[][] = [];
	const waveOf = new Map<string, number>();
	for (const id of colouringOrder) {
		const earliest = Math.max(-1, ...blockersOf(id).map((b) => waveOf.get(b) as number)) + 1;
		let best = members.length;
		let bestAdded = 0;
		for (let w = earliest; w < members.length; w++) {
			const wave = members[w];
			if (wave.length >= maxParallel) continue;
			if (wave.some((m) => blocking.has(pairKey(id, m)))) continue;
			const added = wave.reduce((sum, m) => sum + scoreOf(id, m), 0);
			if (best === members.length || added < bestAdded) {
				best = w;
				bestAdded = added;
			}
		}
		if (best === members.length) members.push([]);
		members[best].push(id);
		waveOf.set(id, best);
	}

	// Merge order inside each wave.
	const laterShare = (id: string, w: number): number => {
		let sum = 0;
		for (let later = w + 1; later < members.length; later++) {
			for (const m of members[later]) sum += scoreOf(id, m);
		}
		return sum;
	};
	let residualRisk = 0;
	const waves: ExecutionWave[] = members.map((wave, w) => {
		const ordered = [...wave].sort(
			(a, b) =>
				laterShare(b, w) - laterShare(a, w) ||
				compareBase((nodes.get(a) as Node).task, (nodes.get(b) as Node).task),
		);
		let residual = 0;
		for (let i = 0; i < ordered.length; i++) {
			for (let j = i + 1; j < ordered.length; j++) {
				residual += scoreOf(ordered[i], ordered[j]);
			}
		}
		residualRisk += residual;
		return { index: w + 1, taskIds: ordered, residualRisk: residual };
	});

	// Specs already running: their drift, and who in the plan shares with them.
	const runningNodes = [...running].sort(compareBase).map(toNode);
	const runningConflicts: WaveRunningConflict[] = [];
	for (const id of plannable) {
		const node = nodes.get(id) as Node;
		for (const other of runningNodes) {
			const { score } = pairScore(node, other);
			if (score > tolerance) {
				runningConflicts.push({ taskId: id, runningTaskId: other.task.id, score });
			}
		}
	}
	runningConflicts.sort((a, b) => b.score - a.score || (a.taskId < b.taskId ? -1 : 1));

	const drift = [...nodes.values(), ...runningNodes]
		.map((node) => computeDrift(node, options.driftThreshold))
		.filter((d): d is WaveDrift => d !== null);

	const tasks: WavePlanTask[] = [...nodes.values(), ...runningNodes].map((node) => ({
		taskId: node.task.id,
		title: node.task.title,
		status: node.task.status,
		fileCount: node.footprint.size,
		planned: node.planned,
	}));

	return {
		waves,
		order: waves.flatMap((w) => w.taskIds),
		tasks,
		pairs,
		cycles,
		excluded,
		drift,
		runningConflicts,
		totalRisk,
		residualRisk,
	};
}
