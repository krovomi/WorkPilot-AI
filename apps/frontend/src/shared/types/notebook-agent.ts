/**
 * Notebook Agent — Types for Jupyter notebook handling.
 */

import type { GeneratedReview } from "./generated-review";

export type CellType = "code" | "markdown" | "raw";

export type NotebookIssueType =
	| "stale_output"
	| "out_of_order"
	| "missing_import"
	| "empty_cell"
	| "long_cell"
	| "no_markdown"
	| "sensitive_output"
	| "used_before_defined"
	| "undefined_name"
	| "hidden_state"
	| "implicit_global"
	| "shared_mutation"
	| "duplicate_code"
	| "execution_error"
	| "assertion_failed"
	| "missing_dependency"
	| "empty_plot"
	| "shape_changed"
	| "output_changed";

export interface NotebookCell {
	index: number;
	cellType: CellType;
	source: string;
	executionCount: number | null;
	outputCount: number;
}

export interface NotebookIssue {
	issueType: NotebookIssueType;
	cellIndex: number;
	message: string;
	severity: string;
	suggestion: string;
}

export interface ParsedNotebook {
	path: string;
	kernel: string;
	language: string;
	totalCells: number;
	codeCells: number;
	markdownCells: number;
	issues: NotebookIssue[];
	cells?: NotebookCellSummary[];
	dependencies?: NotebookDependencies;
	proposals?: NotebookProposal[];
	/** False for Polyglot .dib files, which have no command-line runner. */
	runnable?: boolean;
	/** Only Jupyter notebooks are edited (functions, cleaning). */
	editable?: boolean;
}

/** An edge of the dependency graph: `to` reads `names`, last defined by `from`. */
export interface NotebookEdge {
	from: number;
	to: number;
	names: string[];
}

export interface NotebookDependencies {
	edges: NotebookEdge[];
	/** The order that satisfies every edge, closest to the notebook's; null on a cycle. */
	order: number[] | null;
	inOrder: boolean;
	/** False when a language was read by its declarations only (not Python). */
	precise: boolean;
}

export interface NotebookCellSummary {
	index: number;
	cellType: CellType;
	lines: number;
	firstLine: string;
	executionCount: number | null;
}

/** A long Python cell as a function; `reason` says why it cannot be extracted. */
export interface NotebookProposal {
	cellIndex: number;
	function: string;
	params: string[];
	returns: string[];
	lines: number;
	module: string;
	preview: string;
	reason: string;
}

export type NotebookExecutionStatus =
	| "done"
	| "no_runner"
	| "no_kernel"
	| "timeout"
	| "failed"
	| "unsupported";

export interface NotebookCellRun {
	cellIndex: number;
	status: "ok" | "error" | "skipped" | "empty";
	seconds: number | null;
	error: { name: string; value: string } | null;
	output: { kinds: string[]; text: string; shape: [string, string] | null };
}

export interface NotebookExecution {
	path: string;
	status: NotebookExecutionStatus;
	detail: string;
	hint: string;
	runner: string;
	cells: NotebookCellRun[];
	issues: NotebookIssue[];
	/** Cells that ran without error, in percent. */
	score: number | null;
	/** Cells whose fresh output matches the stored one, in percent. */
	matching: number | null;
	durationS: number;
	outputTail: string;
}

export interface NotebookRunRequest {
	projectPath: string;
	/** Relative to the project. */
	notebook: string;
}

export interface NotebookRefactorRequest extends NotebookRunRequest {
	/** Cell indices to turn into functions. */
	extract: number[];
	/** Remove outputs, execution counts and run metadata. */
	clean: boolean;
}

export interface NotebookRefactorOutcome {
	extracted: NotebookProposal[];
	refused: { cellIndex: number; reason: string }[];
	cleaned: boolean;
	review: GeneratedReview | null;
}

export interface NotebookMonth {
	month: string;
	notebooks: number;
	findings: number;
	runs: number;
	meanScore: number | null;
	extracted: number;
}
