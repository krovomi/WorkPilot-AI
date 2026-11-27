/**
 * Swimlanes of the Kanban (Jira's « couloirs »): the board cut into rows by
 * one field of the cards, each row holding every column.
 *
 * Moving a card to another lane writes that field (priority, type,
 * sub-project), as Jira does for an assignee or an epic; the lanes of a
 * field the board does not own (origin, split task) refuse it. Cards
 * flagged « Bloquée » can be pinned in a lane of their own, first.
 *
 * Design: docs/architecture/kanban-swimlanes.md.
 */
import {
	CARD_TYPE_IDS,
	type CardType,
	cardTypeChoiceMetadata,
	resolveCardType,
} from "../../shared/constants/card-types";
import type { TaskStatusColumn } from "../../shared/constants/task";
import type { Task, TaskPriority } from "../../shared/types";
import { splitGroupId } from "../../shared/utils/task-split";
import type { CardChoice } from "./card-edits";
import { getTaskSource, TASK_SOURCES } from "./kanban-filter";

export type LaneGrouping = "none" | "priority" | "type" | "area" | "source" | "parent";

export const LANE_GROUPINGS: readonly LaneGrouping[] = ["none", "priority", "type", "area", "source", "parent"];

/** The lane of the cards that have no value for the field. */
export const NO_VALUE_LANE = "__none__";
/** The pinned lane of the cards flagged « Bloquée ». */
export const FLAGGED_LANE = "__flagged__";

/** A sub-project name: trimmed, one line, 80 characters at most (as the server checks it). */
export const MAX_AREA_LENGTH = 80;

const PRIORITY_ORDER: readonly TaskPriority[] = ["urgent", "high", "medium", "low"];

export interface LaneOptions {
	grouping: LaneGrouping;
	/** Flagged cards in the first lane, whatever their field. */
	pinFlagged: boolean;
	/** Sub-projects known without a card (project index, added by hand). */
	knownAreas?: readonly string[];
}

export interface Lane {
	key: string;
	/** The field's value, for the label; absent for the no-value and flagged lanes. */
	value?: string;
	/** The cards of the lane, column by column. */
	columns: Partial<Record<TaskStatusColumn, Task[]>>;
	count: number;
}

function isControl(char: string): boolean {
	const code = char.charCodeAt(0);
	return code < 0x20 || code === 0x7f;
}

/** A sub-project name as a card stores it, or null when it is not one. */
export function cleanArea(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const area = raw.trim();
	if (!area || area.length > MAX_AREA_LENGTH || [...area].some(isControl)) return null;
	return area;
}

function fieldValue(task: Task, grouping: LaneGrouping): string | null {
	const metadata = task.metadata;
	switch (grouping) {
		case "priority":
			return metadata?.priority || null;
		case "type":
			return resolveCardType(metadata)?.type ?? null;
		case "area":
			return cleanArea(metadata?.area);
		case "source":
			return getTaskSource(task);
		case "parent":
			return splitGroupId(task);
		default:
			return null;
	}
}

/** The lane a card sits in. */
export function laneKeyOf(task: Task, options: Pick<LaneOptions, "grouping" | "pinFlagged">): string {
	if (options.pinFlagged && task.metadata?.flagged === true) return FLAGGED_LANE;
	return fieldValue(task, options.grouping) ?? NO_VALUE_LANE;
}

/** True when moving a card to another lane of this grouping writes its field. */
export function isEditableGrouping(grouping: LaneGrouping): boolean {
	return grouping === "priority" || grouping === "type" || grouping === "area";
}

/** The lanes shown even empty: they are where a card is moved to. */
function fixedValues(options: LaneOptions): string[] {
	if (options.grouping === "priority") return [...PRIORITY_ORDER];
	if (options.grouping === "area") {
		return (options.knownAreas ?? []).map(cleanArea).filter((area): area is string => !!area);
	}
	return [];
}

function ordered(grouping: LaneGrouping, values: string[]): string[] {
	const rank = (order: readonly string[], value: string) => {
		const index = order.indexOf(value);
		return index === -1 ? order.length : index;
	};
	const byOrder = (order: readonly string[]) => values.sort((a, b) => rank(order, a) - rank(order, b));
	if (grouping === "priority") return byOrder(PRIORITY_ORDER);
	if (grouping === "type") return byOrder(CARD_TYPE_IDS);
	if (grouping === "source") return byOrder(TASK_SOURCES);
	return values.sort((a, b) => a.localeCompare(b));
}

/**
 * Cuts the board's columns into lanes: the flagged lane first (when pinned
 * and not empty), then the field's values in their order, then the cards
 * without a value. A column keeps the order the board gave its cards.
 */
export function buildLanes(
	tasksByColumn: Partial<Record<TaskStatusColumn, Task[]>>,
	options: LaneOptions,
): Lane[] {
	if (options.grouping === "none") return [];
	const lanes = new Map<string, Lane>();
	const laneOf = (key: string): Lane => {
		let lane = lanes.get(key);
		if (!lane) {
			const value = key === FLAGGED_LANE || key === NO_VALUE_LANE ? undefined : key;
			lane = { key, value, columns: {}, count: 0 };
			lanes.set(key, lane);
		}
		return lane;
	};
	for (const [column, tasks] of Object.entries(tasksByColumn) as [TaskStatusColumn, Task[] | undefined][]) {
		for (const task of tasks ?? []) {
			const lane = laneOf(laneKeyOf(task, options));
			const cards = lane.columns[column] ?? [];
			cards.push(task);
			lane.columns[column] = cards;
			lane.count++;
		}
	}
	for (const value of fixedValues(options)) laneOf(value);
	const values = ordered(
		options.grouping,
		[...lanes.keys()].filter((key) => key !== FLAGGED_LANE && key !== NO_VALUE_LANE),
	);
	const result: Lane[] = [];
	const flagged = lanes.get(FLAGGED_LANE);
	if (flagged) result.push(flagged);
	for (const value of values) result.push(laneOf(value));
	// Where a card goes when its field is cleared: shown even empty for a field the board writes.
	if (lanes.has(NO_VALUE_LANE) || options.grouping === "priority" || options.grouping === "area") {
		result.push(laneOf(NO_VALUE_LANE));
	}
	return result;
}

/**
 * What a card moved into a lane gets written; null when the grouping's
 * field is not the board's to change, or for the flagged lane (reached by
 * flagging) and the no-type lane (a type is chosen, never cleared).
 */
export function laneMetadata(grouping: LaneGrouping, laneKey: string): CardChoice | null {
	if (!isEditableGrouping(grouping) || laneKey === FLAGGED_LANE) return null;
	const value = laneKey === NO_VALUE_LANE ? undefined : laneKey;
	if (grouping === "priority") {
		if (value !== undefined && !PRIORITY_ORDER.includes(value as TaskPriority)) return null;
		return { priority: value as TaskPriority | undefined };
	}
	if (grouping === "type") {
		if (value === undefined || !CARD_TYPE_IDS.includes(value as CardType)) return null;
		return cardTypeChoiceMetadata(value as CardType);
	}
	if (value === undefined) return { area: undefined };
	const area = cleanArea(value);
	return area ? { area } : null;
}

const DROP_PREFIX = "lane::";

/** The drop target of one column in one lane (dnd-kit ids are unique on a board). */
export function laneDropId(laneKey: string, column: TaskStatusColumn): string {
	return `${DROP_PREFIX}${column}::${laneKey}`;
}

/** The lane and column of a lane drop target, or null for any other id. */
export function parseLaneDropId(id: string): { lane: string; column: TaskStatusColumn } | null {
	if (!id.startsWith(DROP_PREFIX)) return null;
	const rest = id.slice(DROP_PREFIX.length);
	const cut = rest.indexOf("::");
	if (cut <= 0 || cut + 2 >= rest.length) return null;
	return { column: rest.slice(0, cut) as TaskStatusColumn, lane: rest.slice(cut + 2) };
}
