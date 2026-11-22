/**
 * Quick add from a Kanban column: what the person typed becomes one card, or
 * one card per line when they paste a list. Pure functions, so the composer
 * (`components/kanban/QuickAddComposer.tsx`) only renders and calls them.
 * Design: docs/architecture/kanban-quick-edit.md.
 */
import {
	type CardType,
	cardTypeChoiceMetadata,
} from "../../shared/constants/card-types";
import type {
	TaskEngine,
	TaskMetadata,
	TaskPriority,
} from "../../shared/types";
import { buildEngineMetadata } from "../../shared/utils/task-engine";
import type { QuickAddColumn } from "./kanban-columns";

/** A line this long or shorter reads as a title; longer is a description. */
export const QUICK_ADD_TITLE_MAX = 120;
/** One paste never creates more cards than this. */
export const QUICK_ADD_MAX_CARDS = 50;

export interface QuickAddItem {
	/** Empty: the main process generates one from the description. */
	title: string;
	description: string;
}

// A list marker a pasted line may start with: "- ", "* ", "• ", "+ ", "1. ",
// "2) ", "[ ] ", "[x] ".
const LIST_MARKER = /^(?:[-*•+]|\d{1,3}[.)]|\[[ xX]\])\s+/;

/** The non-empty lines of `text`, list markers removed. */
export function quickAddLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim().replace(LIST_MARKER, "").trim())
		.filter((line) => line.length > 0);
}

/**
 * Whether one card per line is the right default: at least two lines, all
 * short enough to be titles. A multi-line description (long lines) stays one
 * card unless the person asks otherwise.
 */
export function splitsByDefault(text: string): boolean {
	const lines = quickAddLines(text);
	return (
		lines.length > 1 && lines.every((line) => line.length <= QUICK_ADD_TITLE_MAX)
	);
}

function itemFrom(text: string): QuickAddItem {
	const isTitle = !text.includes("\n") && text.length <= QUICK_ADD_TITLE_MAX;
	return { title: isTitle ? text : "", description: text };
}

/** The cards `text` creates: one per line when `split`, else one. */
export function buildQuickAddItems(
	text: string,
	split: boolean,
): QuickAddItem[] {
	if (split) {
		return quickAddLines(text).slice(0, QUICK_ADD_MAX_CARDS).map(itemFrom);
	}
	const whole = text.trim();
	return whole ? [itemFrom(whole)] : [];
}

export interface QuickAddChoices {
	/** The engine the card owns from the start, seeded like the wizard's. */
	engine: TaskEngine;
	type?: CardType | null;
	priority?: TaskPriority | null;
}

/** The metadata of a quick-added card: a manual card with its own engine. */
export function quickAddMetadata({
	engine,
	type,
	priority,
}: QuickAddChoices): TaskMetadata {
	const metadata: TaskMetadata = {
		sourceType: "manual",
		...buildEngineMetadata(engine),
	};
	if (priority) metadata.priority = priority;
	if (type) Object.assign(metadata, cardTypeChoiceMetadata(type));
	return metadata;
}

/** The words of the quick add in each column (i18n keys of the `tasks` namespace). */
export const QUICK_ADD_LABELS: Record<
	QuickAddColumn,
	{ header: string; tooltip: string; row: string; create: string; createMany: string }
> = {
	backlog: {
		header: "kanban.addTaskAriaLabel",
		tooltip: "kanban.quickAdd.addTooltip",
		row: "kanban.quickAdd.addCard",
		create: "kanban.quickAdd.create",
		createMany: "kanban.quickAdd.createMany",
	},
	queue: {
		header: "kanban.quickAdd.addQueued",
		tooltip: "kanban.quickAdd.addQueued",
		row: "kanban.quickAdd.addQueued",
		create: "kanban.quickAdd.queue",
		createMany: "kanban.quickAdd.createMany",
	},
	in_progress: {
		header: "kanban.quickAdd.addStarted",
		tooltip: "kanban.quickAdd.addStarted",
		row: "kanban.quickAdd.addStarted",
		create: "kanban.quickAdd.start",
		createMany: "kanban.quickAdd.startMany",
	},
};
