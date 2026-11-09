/**
 * The Kanban's quick-command bar runs a command on a review card
 * (`main/quick-command/quick-command-run.ts`, F181).
 */
import type { GeneratedReview } from "./generated-review";

/** What the renderer asks for: a project by its id, a command by its name. */
export interface QuickCommandRequest {
	readonly projectId: string;
	/** The command's name, without its leading slash. */
	readonly command: string;
	readonly args?: string;
}

export interface QuickCommandOutcome {
	/** The command ran to the end. */
	readonly ok: boolean;
	/** The agent's answer, or why the command failed. */
	readonly output: string;
	/** The card the agent's files wait on, or null when it wrote nothing. */
	readonly review: GeneratedReview | null;
	/** Set when the files were written but could not be committed. */
	readonly uncommittedIn?: string;
}
