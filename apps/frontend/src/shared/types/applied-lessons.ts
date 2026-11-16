/**
 * The lessons a task's prompts carried (`learning_loop/applied.py`).
 *
 * Every prompt that asks the Learning Loop for its lessons with the task's
 * spec directory in hand records them in `<spec>/applied_lessons.json`: the
 * rules adopted from reviews, the patterns learned from builds, and the
 * checkpoints of the task's kind when the repository's QA history asks for
 * them. The person can turn one off for this task alone.
 */

export type AppliedLessonKind = "rule" | "pattern" | "checkpoint";

export interface AppliedLesson {
	id: string;
	kind: AppliedLessonKind;
	text: string;
	/** The agents that were given it: `spec_writer`, `planner`, `coder`… */
	agents: string[];
	/** `success`, `failure` or `optimization`, for a pattern. */
	patternType?: string;
	confidence?: number;
	/** When a prompt last carried it (ISO 8601). */
	at?: string;
}

export interface AppliedLessonsState {
	lessons: AppliedLesson[];
	/** The ids turned off for this task; later prompts leave them out. */
	disabled: string[];
}
