/**
 * Sprints of a project's Kanban (Jira's sprints, Linear's cycles): a named
 * box of cards with an optional goal and calendar dates, planned, then
 * active, then closed with what was done and what was carried over.
 *
 * Stored in the project's `.workpilot/sprints.json` (locally by
 * `main/sprints/`, on the server by `shared_board/sprints.py`); a card names
 * its sprint in `metadata.sprintId`. Points are the card's Smart Estimation
 * score (1-13), never a duration.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */

export type SprintState = "planned" | "active" | "closed";

/** What a closed sprint did, kept for the velocity and the reports. */
export interface SprintReport {
	/** Cards done in the sprint, and their points. */
	done: number;
	donePoints: number;
	/** Cards moved on (to another sprint or back to the backlog). */
	carried: number;
	carriedPoints: number;
	/** Where they went: a sprint id, or null for the backlog. */
	carriedTo: string | null;
}

/** What the sprint held when it started (for the burndown). */
export interface SprintCommitment {
	cards: number;
	points: number;
}

export interface Sprint {
	/** `sp-` and 8 hexadecimal characters. */
	id: string;
	name: string;
	goal?: string;
	state: SprintState;
	/** Calendar days `YYYY-MM-DD`, as the person set them. */
	startDate?: string;
	endDate?: string;
	createdAt: string;
	startedAt?: string;
	closedAt?: string;
	committed?: SprintCommitment;
	report?: SprintReport;
}

/** What a person edits on a sprint; `id` absent creates one. */
export interface SprintDraft {
	id?: string;
	name: string;
	goal?: string;
	startDate?: string;
	endDate?: string;
}
