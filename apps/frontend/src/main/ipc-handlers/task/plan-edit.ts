/**
 * Plan edits from the Subtasks tab.
 *
 * The renderer sends the phases it shows, but it only knows a flattened view
 * of the plan: one phase, a `title` copied from the description, the files
 * merged into one list. Writing that back as the plan lost the planner's
 * phases (names, ids, dependencies) and the backend field names. So the edit
 * is read as a list of pending-subtask changes and applied to the plan on disk:
 * a pending subtask can be reworded, lose files or be removed, a new one is
 * added at the end, and any other subtask stays exactly as the build left it.
 */

const SUBTASK_ID = /^[\w.-]{1,128}$/;
const MAX_SUBTASKS = 500;
const MAX_TEXT = 10_000;
const MAX_FILES = 1_000;
const MAX_PATH = 4_096;
const FILE_KEYS = ["files", "files_to_modify", "files_to_create"] as const;

export interface SubtaskEdit {
	id: string;
	description: string;
	files?: string[];
}

type PlanRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlanRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiles(value: unknown): string[] | undefined | null {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_FILES) return null;
	if (!value.every((f) => typeof f === "string" && f.length <= MAX_PATH)) return null;
	return value as string[];
}

/**
 * The edits carried by the phases the renderer sent, or null when they are not
 * well formed (the handler then refuses the whole save).
 */
export function parsePlanEdit(phases: unknown): SubtaskEdit[] | null {
	if (!Array.isArray(phases)) return null;
	const edits: SubtaskEdit[] = [];
	const seen = new Set<string>();
	for (const phase of phases) {
		if (!isRecord(phase) || !Array.isArray(phase.subtasks)) return null;
		for (const subtask of phase.subtasks) {
			if (!isRecord(subtask)) return null;
			const { id } = subtask;
			if (typeof id !== "string" || !SUBTASK_ID.test(id) || seen.has(id)) return null;
			const text = subtask.description ?? subtask.title ?? "";
			if (typeof text !== "string" || text.length > MAX_TEXT) return null;
			const files = readFiles(subtask.files);
			if (files === null) return null;
			seen.add(id);
			edits.push({ id, description: text.trim(), ...(files ? { files } : {}) });
			if (edits.length > MAX_SUBTASKS) return null;
		}
	}
	return edits;
}

function subtaskListKey(phase: PlanRecord): "subtasks" | "chunks" {
	return !Array.isArray(phase.subtasks) && Array.isArray(phase.chunks) ? "chunks" : "subtasks";
}

function edited(subtask: PlanRecord, edit: SubtaskEdit): PlanRecord {
	const next: PlanRecord = { ...subtask };
	if (edit.description) {
		next.description = edit.description;
		if (typeof next.title === "string") next.title = edit.description.split("\n")[0].slice(0, 120);
	}
	if (edit.files) {
		const kept = new Set(edit.files);
		for (const key of FILE_KEYS) {
			const list = next[key];
			if (Array.isArray(list)) next[key] = list.filter((f) => kept.has(f));
		}
	}
	return next;
}

/**
 * Apply the edits to the plan and return it. Pending subtasks absent from the
 * edits are removed; subtasks that are running, done, blocked or failed are
 * never touched; an edit with an unknown id and some text becomes a new pending
 * subtask in the last phase.
 */
export function applyPlanEdit(plan: PlanRecord, edits: SubtaskEdit[]): PlanRecord {
	const byId = new Map(edits.map((edit) => [edit.id, edit]));
	const known = new Set<string>();
	const phases = (Array.isArray(plan.phases) ? plan.phases : []).map((phase) => {
		if (!isRecord(phase)) return phase;
		const key = subtaskListKey(phase);
		const list = Array.isArray(phase[key]) ? (phase[key] as unknown[]) : [];
		const kept = list.flatMap((subtask) => {
			if (!isRecord(subtask)) return [subtask];
			if (typeof subtask.id === "string") known.add(subtask.id);
			if (subtask.status !== "pending") return [subtask];
			const edit = typeof subtask.id === "string" ? byId.get(subtask.id) : undefined;
			return edit ? [edited(subtask, edit)] : [];
		});
		return { ...phase, [key]: kept };
	});

	const added = edits
		.filter((edit) => !known.has(edit.id) && edit.description)
		.map((edit) => ({
			id: edit.id,
			description: edit.description,
			status: "pending",
			files_to_modify: [],
		}));
	if (added.length > 0) {
		let last = phases.length - 1;
		while (last >= 0 && !isRecord(phases[last])) last--;
		if (last < 0) {
			phases.push({ name: "Implementation", subtasks: added });
		} else {
			const phase = phases[last] as PlanRecord;
			const key = subtaskListKey(phase);
			phases[last] = { ...phase, [key]: [...(phase[key] as unknown[]), ...added] };
		}
	}
	return { ...plan, phases };
}
