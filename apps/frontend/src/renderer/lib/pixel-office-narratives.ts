/**
 * Pixel Office mini-scenes: what just happened to a task, told as a moment
 * between the agents ("Coder hands spec #042 in to QA Reviewer").
 *
 * A scene comes from a normalized transition of the task (its status, its
 * execution phase), never from a provider-specific signal, so every provider
 * gets the same scenes. The roles are the pipeline's; the provider family
 * running each phase is named next to it when the task says which one.
 * Writing the scene is the view's job (templates, or the page's model when the
 * person asked for it): this module only says which scene it is.
 */

import type {
	NarrativeKind,
	NarrativeRequest,
	NarrativeRole,
	ProviderFamily,
} from "../../shared/types/pixel-office";
import type { ExecutionPhase, Task } from "../../shared/types/task";
import type { EnginePhase } from "../../shared/utils/task-engine";
import { phaseFamily } from "./pixel-office-providers";

/** A scene to tell, before it is written. */
export interface NarrativeEvent {
	kind: NarrativeKind;
	taskId: string;
	title: string;
	/** The spec's number (`042`), or empty. */
	spec: string;
	from?: NarrativeRole;
	to?: NarrativeRole;
	fromFamily?: ProviderFamily;
	toFamily?: ProviderFamily;
}

/** How long a task title may be in a scene. */
export const NARRATIVE_TITLE_MAX = 120;

const SHIPPED = new Set<Task["status"]>(["done", "pr_created"]);
const WORKING = new Set<Task["status"]>(["in_progress", "ai_review"]);

/** The engine phase each role works in (the person has none). */
const ROLE_PHASE: Record<NarrativeRole, EnginePhase | null> = {
	planner: "planning",
	coder: "coding",
	reviewer: "qa",
	fixer: "qa",
	you: null,
};

const PHASE_ROLE: Partial<Record<ExecutionPhase, NarrativeRole>> = {
	planning: "planner",
	coding: "coder",
	qa_review: "reviewer",
	qa_fixing: "fixer",
};

/** The spec number a spec id starts with (`042-dark-mode` → `042`). */
export function specNumberOf(specId: string | undefined): string {
	return /^(\d{1,6})(?:-|$)/.exec(specId ?? "")?.[1] ?? "";
}

type Scene = Pick<NarrativeEvent, "kind" | "from" | "to">;

/** Which scene a change of status or phase is, if any. */
function sceneOf(previous: Task, next: Task): Scene | null {
	if (previous.status !== next.status) {
		if (SHIPPED.has(next.status) && !SHIPPED.has(previous.status))
			return { kind: "shipped" };
		if (next.status === "error")
			return {
				kind: "stumbled",
				from: PHASE_ROLE[previous.executionProgress?.phase ?? "coding"] ?? "coder",
			};
		if (next.status === "human_review" && WORKING.has(previous.status))
			return { kind: "qa-approved", from: "reviewer", to: "you" };
		return null;
	}
	const before = previous.executionProgress?.phase;
	const after = next.executionProgress?.phase;
	if (before === after) return null;
	if (before === "planning" && after === "coding")
		return { kind: "plan-ready", from: "planner", to: "coder" };
	if (before === "coding" && after === "qa_review")
		return { kind: "handed-to-qa", from: "coder", to: "reviewer" };
	if (before === "qa_review" && after === "qa_fixing")
		return { kind: "qa-sent-back", from: "reviewer", to: "fixer" };
	return null;
}

function familyOf(task: Task, role: NarrativeRole | undefined) {
	const phase = role ? ROLE_PHASE[role] : null;
	return phase ? phaseFamily(task, phase) : undefined;
}

/** The scene between two states of the same task, or null. */
export function narrativeFor(previous: Task, next: Task): NarrativeEvent | null {
	const scene = sceneOf(previous, next);
	if (!scene) return null;
	const event: NarrativeEvent = {
		...scene,
		taskId: next.id,
		title: next.title.slice(0, NARRATIVE_TITLE_MAX),
		spec: specNumberOf(next.specId),
	};
	const fromFamily = familyOf(next, scene.from);
	const toFamily = familyOf(next, scene.to);
	if (fromFamily) event.fromFamily = fromFamily;
	if (toFamily) event.toFamily = toFamily;
	return event;
}

/**
 * The scenes between two readings of a project's tasks. A task seen for the
 * first time tells nothing: opening the office is not an event.
 */
export function narrativesBetween(
	previous: ReadonlyMap<string, Task>,
	tasks: readonly Task[],
): NarrativeEvent[] {
	const events: NarrativeEvent[] = [];
	for (const task of tasks) {
		const before = previous.get(task.id);
		const event = before && narrativeFor(before, task);
		if (event) events.push(event);
	}
	return events;
}

/**
 * The request the main process checks again before asking a model. The title
 * stays here: it can come from an imported ticket, and the scene does not
 * need it to be told.
 */
export function narrativeRequestOf(
	event: NarrativeEvent,
	language: string,
): NarrativeRequest {
	const { taskId: _taskId, title: _title, ...scene } = event;
	return { ...scene, language: language.startsWith("fr") ? "fr" : "en" };
}
