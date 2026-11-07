/**
 * The guided review, without git and without a model: the task's diff
 * grouped by what the plan said each subtask would do.
 *
 * The main process (`review-groups-handlers.ts`) reads the plan, the commits
 * the build recorded (`memory/build_commits.json`) and the branch's commits,
 * asks `planRanges` which ranges to diff, runs `git diff` on each, and hands
 * the files to `finalizeGroups`. Everything that decides something lives here
 * so it is tested without a repository.
 */
import type { WorktreeDiffFile } from "../types/task";
import type {
	ReviewGroup,
	ReviewGroupFile,
	ReviewGroupKind,
	ReviewGroups,
	ReviewMovedBlock,
	ReviewQaNote,
} from "../types/review-groups";

/** A subtask as the planner wrote it in `implementation_plan.json`. */
export interface PlanSubtaskInfo {
	id: string;
	title: string;
	description: string;
	/** `files_to_modify` + `files_to_create` (+ `files_changed`, git's truth). */
	files: string[];
}

/** One line of `build_commits.json`'s `commits`. */
export interface BuildCommitRecord {
	hash: string;
	subtaskId: string;
	/** HEAD when the session started; absent in records of older builds. */
	commitBefore?: string;
}

export interface BranchCommit {
	hash: string;
	subject: string;
}

/** A range the main process must diff, in the order the commits were made. */
export interface ReviewRange {
	kind: Exclude<ReviewGroupKind, "uncommitted">;
	from: string;
	to: string;
	subtaskId?: string;
	/** The commit's subject, for an unrecorded commit. */
	subject?: string;
}

export interface PlannedRanges {
	ranges: ReviewRange[];
	approximate: boolean;
}

/** `files_to_modify` in plan form: forward slashes, no leading `./`. */
export function normalizePath(p: string): string {
	return p.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The subtasks of `implementation_plan.json`, in plan order. */
export function planSubtasks(plan: unknown): PlanSubtaskInfo[] {
	const phases = (plan as { phases?: unknown })?.phases;
	if (!Array.isArray(phases)) return [];
	const out: PlanSubtaskInfo[] = [];
	for (const phase of phases) {
		const subtasks = (phase as { subtasks?: unknown })?.subtasks;
		if (!Array.isArray(subtasks)) continue;
		for (const raw of subtasks) {
			const s = raw as Record<string, unknown>;
			if (typeof s?.id !== "string" || !s.id) continue;
			const files = ["files_to_modify", "files_to_create", "files_changed"]
				.flatMap((k) => (Array.isArray(s[k]) ? (s[k] as unknown[]) : []))
				.filter((f): f is string => typeof f === "string" && f.trim() !== "")
				.map(normalizePath);
			const description = typeof s.description === "string" ? s.description : "";
			const title = typeof s.title === "string" && s.title ? s.title : description;
			out.push({ id: s.id, title, description, files });
		}
	}
	return out;
}

/** The records of `build_commits.json`, oldest first; malformed lines dropped. */
export function buildCommitRecords(data: unknown): BuildCommitRecord[] {
	const commits = (data as { commits?: unknown })?.commits;
	if (!Array.isArray(commits)) return [];
	const out: BuildCommitRecord[] = [];
	for (const raw of commits) {
		const c = raw as Record<string, unknown>;
		if (typeof c?.hash !== "string" || typeof c.subtask_id !== "string") continue;
		out.push({
			hash: c.hash,
			subtaskId: c.subtask_id,
			commitBefore: typeof c.commit_before === "string" ? c.commit_before : undefined,
		});
	}
	return out;
}

/** The latest QA iteration's issues that name a file. */
export function latestQaNotes(plan: unknown): ReviewQaNote[] {
	const history = (plan as { qa_iteration_history?: unknown })?.qa_iteration_history;
	if (!Array.isArray(history) || history.length === 0) return [];
	const issues = (history[history.length - 1] as { issues?: unknown })?.issues;
	if (!Array.isArray(issues)) return [];
	const notes: ReviewQaNote[] = [];
	for (const raw of issues) {
		const i = raw as Record<string, unknown>;
		if (typeof i?.file !== "string" || !i.file.trim()) continue;
		const line = Number(i.line);
		const severity = [i.severity, i.type, i.priority].find(
			(v): v is string => typeof v === "string" && v !== "",
		);
		notes.push({
			file: normalizePath(i.file),
			line: Number.isInteger(line) && line > 0 ? line : null,
			title: typeof i.title === "string" ? i.title : "",
			severity: severity ?? "issue",
		});
	}
	return notes;
}

/**
 * Which ranges to diff. Each recorded subtask owns `commitBefore..hash`; an
 * older record without `commitBefore` starts at the previous record (or the
 * merge-base), and the result says it is approximate. A commit no record
 * covers (QA fixer, a person, a sync with the base) is a group of its own.
 * Consecutive commits of one subtask form one range.
 *
 * `commits` is the branch's first-parent history from the merge-base,
 * oldest first.
 */
export function planRanges(
	mergeBase: string,
	commits: BranchCommit[],
	records: BuildCommitRecord[],
): PlannedRanges {
	const position = new Map<string, number>([[mergeBase, -1]]);
	commits.forEach((c, i) => position.set(c.hash, i));
	const owner: (string | undefined)[] = commits.map(() => undefined);
	let approximate = false;
	let previous = -1;
	for (const record of records) {
		const end = position.get(record.hash);
		if (end === undefined) continue; // rebased away or not on this branch
		let start = record.commitBefore ? position.get(record.commitBefore) : undefined;
		if (start === undefined) {
			start = previous;
			approximate = true;
		}
		for (let i = start + 1; i <= end; i++) owner[i] ??= record.subtaskId;
		previous = Math.max(previous, end);
	}

	const ranges: ReviewRange[] = [];
	commits.forEach((commit, i) => {
		const from = i === 0 ? mergeBase : commits[i - 1].hash;
		const subtaskId = owner[i];
		const last = ranges[ranges.length - 1];
		if (subtaskId && last?.kind === "subtask" && last.subtaskId === subtaskId && last.to === from) {
			last.to = commit.hash;
		} else if (subtaskId) {
			ranges.push({ kind: "subtask", from, to: commit.hash, subtaskId });
		} else {
			ranges.push({ kind: "commit", from, to: commit.hash, subject: commit.subject });
		}
	});
	return { ranges, approximate };
}

/** FNV-1a, 32 bits: a patch's identity for "viewed", not a security hash. */
export function patchHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Moved code ────────────────────────────────────────────────────────

/** Git's own threshold for a moved block (`--color-moved`): 20 alphanumerics. */
const MIN_MOVED_ALNUM = 20;
const MIN_MOVED_LINES = 3;

interface Block {
	path: string;
	hunk: number;
	key: string;
	lines: number;
	preview: string;
}

/** Runs of removed and added lines, each line trimmed, blank lines dropped. */
function blocksOf(path: string, patch: string): { removed: Block[]; added: Block[] } {
	const removed: Block[] = [];
	const added: Block[] = [];
	let hunk = -1;
	let run: { sign: string; lines: string[] } | null = null;
	const flush = () => {
		if (!run) return;
		const lines = run.lines.map((l) => l.trim()).filter(Boolean);
		const alnum = lines.join("").replace(/[^A-Za-z0-9]/g, "").length;
		if (lines.length >= MIN_MOVED_LINES && alnum >= MIN_MOVED_ALNUM) {
			const block = { path, hunk, key: lines.join("\n"), lines: lines.length, preview: lines[0] };
			(run.sign === "-" ? removed : added).push(block);
		}
		run = null;
	};
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) {
			flush();
			hunk++;
			continue;
		}
		if (hunk < 0 || line.startsWith("+++") || line.startsWith("---")) continue;
		const sign = line[0];
		if (sign === "+" || sign === "-") {
			if (run && run.sign !== sign) flush();
			run ??= { sign, lines: [] };
			run.lines.push(line.slice(1));
		} else {
			flush();
		}
	}
	flush();
	return { removed, added };
}

/**
 * Blocks removed in one place and added unchanged in another, among one
 * group's files. A block changed while it moved is not paired, nor a block
 * re-indented in place (same hunk of the same file): that is an edit.
 */
export function findMovedBlocks(
	files: Pick<WorktreeDiffFile, "path" | "patch">[],
): Map<string, ReviewMovedBlock[]> {
	const removed: Block[] = [];
	const added: Block[] = [];
	for (const f of files) {
		if (!f.patch) continue;
		const blocks = blocksOf(f.path, f.patch);
		removed.push(...blocks.removed);
		added.push(...blocks.added);
	}
	const moved = new Map<string, ReviewMovedBlock[]>();
	const note = (path: string, block: ReviewMovedBlock) => {
		const list = moved.get(path) ?? [];
		list.push(block);
		moved.set(path, list);
	};
	const used = new Set<Block>();
	for (const out of removed) {
		const into = added.find(
			(a) => !used.has(a) && a.key === out.key && (a.path !== out.path || a.hunk !== out.hunk),
		);
		if (!into) continue;
		used.add(into);
		note(into.path, { direction: "in", otherPath: out.path, lines: into.lines, preview: into.preview });
		note(out.path, { direction: "out", otherPath: into.path, lines: out.lines, preview: out.preview });
	}
	return moved;
}

// ── Groups ────────────────────────────────────────────────────────────

/** A range once diffed, or the uncommitted changes (`range` absent). */
export interface DiffedRange {
	range?: ReviewRange;
	files: WorktreeDiffFile[];
}

function groupKey(range: ReviewRange | undefined): string {
	if (!range) return "uncommitted";
	return range.kind === "subtask" ? `subtask:${range.subtaskId}:${range.to}` : `commit:${range.to}`;
}

/**
 * The groups the review shows: subtasks in plan order, then the commits no
 * subtask recorded, then the uncommitted changes. `diffed` is in commit
 * order, which is what "changed again later" is measured against.
 */
export function finalizeGroups(
	diffed: DiffedRange[],
	subtasks: PlanSubtaskInfo[],
	qaNotes: ReviewQaNote[],
	approximate: boolean,
): ReviewGroups {
	const announced = new Set(subtasks.flatMap((s) => s.files));
	const byId = new Map(subtasks.map((s) => [s.id, s]));
	const chronological = diffed.filter((d) => d.files.length > 0);
	const keys = chronological.map((d) => groupKey(d.range));

	// Where each path is changed, in commit order: the QA note goes to the
	// last change, "changed again" points from earlier groups to later ones.
	const changes = new Map<string, number[]>();
	chronological.forEach((d, i) => {
		for (const f of d.files) {
			const path = normalizePath(f.path);
			changes.set(path, [...(changes.get(path) ?? []), i]);
		}
	});
	const outOfPlan = [...changes.keys()].filter((p) => !announced.has(p)).sort();
	const anchored = new Set<ReviewQaNote>();

	const groups: ReviewGroup[] = chronological.map((d, i) => {
		const moved = findMovedBlocks(d.files);
		const files: ReviewGroupFile[] = d.files.map((f) => {
			const path = normalizePath(f.path);
			const at = changes.get(path) ?? [];
			const lastChange = at[at.length - 1] === i;
			const notes = lastChange ? qaNotes.filter((n) => n.file === path) : [];
			for (const n of notes) anchored.add(n);
			return {
				...f,
				hash: patchHash(f.patch ?? `${f.status}:${f.path}`),
				outOfPlan: !announced.has(path),
				touchedLater: at.filter((j) => j > i).map((j) => keys[j]),
				moved: moved.get(f.path) ?? [],
				qaNotes: notes,
			};
		});
		const range = d.range;
		const subtask = range?.subtaskId ? byId.get(range.subtaskId) : undefined;
		return {
			key: keys[i],
			kind: range?.kind ?? "uncommitted",
			title: subtask?.title ?? range?.subject ?? range?.subtaskId ?? "",
			description: subtask?.description ?? "",
			subtaskId: range?.subtaskId,
			from: range?.from,
			to: range?.to,
			files,
		};
	});

	// A subtask recorded in several separate ranges: number its parts.
	const counts = new Map<string, number>();
	for (const g of groups) if (g.subtaskId) counts.set(g.subtaskId, (counts.get(g.subtaskId) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const g of groups) {
		const total = g.subtaskId ? (counts.get(g.subtaskId) ?? 1) : 1;
		if (!g.subtaskId || total < 2) continue;
		const part = (seen.get(g.subtaskId) ?? 0) + 1;
		seen.set(g.subtaskId, part);
		g.part = part;
		g.parts = total;
	}

	const planOrder = new Map(subtasks.map((s, i) => [s.id, i]));
	const rank = (g: ReviewGroup) =>
		g.kind === "subtask" ? (planOrder.get(g.subtaskId ?? "") ?? subtasks.length) : g.kind === "commit" ? subtasks.length + 1 : subtasks.length + 2;
	const ordered = groups
		.map((g, i) => ({ g, i }))
		.sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
		.map(({ g }) => g);

	return {
		groups: ordered,
		outOfPlan,
		unanchoredQa: qaNotes.filter((n) => !anchored.has(n)),
		approximate,
	};
}

// ── "Viewed" ──────────────────────────────────────────────────────────

/** `${group.key}|${path}` → the patch hash that was viewed. */
export type ViewedState = Record<string, string>;

export function viewedKey(group: Pick<ReviewGroup, "key">, file: Pick<ReviewGroupFile, "path">): string {
	return `${group.key}|${file.path}`;
}

/** Viewed only while the patch is the one that was viewed. */
export function isViewed(state: ViewedState, group: Pick<ReviewGroup, "key">, file: Pick<ReviewGroupFile, "path" | "hash">): boolean {
	return state[viewedKey(group, file)] === file.hash;
}

export function setViewed(
	state: ViewedState,
	group: Pick<ReviewGroup, "key">,
	file: Pick<ReviewGroupFile, "path" | "hash">,
	viewed: boolean,
): ViewedState {
	const key = viewedKey(group, file);
	const next = { ...state };
	if (viewed) next[key] = file.hash;
	else delete next[key];
	return next;
}

/** Drop what no longer matches a file of `groups`, so the store does not grow. */
export function pruneViewed(state: ViewedState, groups: ReviewGroup[]): ViewedState {
	const next: ViewedState = {};
	for (const g of groups) {
		for (const f of g.files) {
			if (isViewed(state, g, f)) next[viewedKey(g, f)] = f.hash;
		}
	}
	return next;
}
