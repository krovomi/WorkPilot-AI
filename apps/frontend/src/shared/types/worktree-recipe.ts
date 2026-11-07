/**
 * The worktree recipe of a project (`apps/backend/core/workspace/recipe.py`):
 * what WorkPilot runs in each new task worktree before the first session.
 */

export interface WorktreeRecipe {
	/** `file` is `.workpilot/worktree.toml`; `detected` is what the stack implies. */
	source: "file" | "detected";
	/** One argument list per command; never a shell string. */
	setup: string[][];
	copy: string[];
	link: string[];
	passEnv: string[];
	timeoutSeconds: number;
	ports: number;
	teardown: string[][];
	/** The project's proof checkers, run by the QA gate `proof-checks` (absent before P2). */
	proofs?: string[][];
	proofTimeoutSeconds?: number;
	errors: string[];
	notes: string[];
	digest: string;
}

export interface WorktreeRecipeState {
	recipe: WorktreeRecipe;
	detected: WorktreeRecipe;
	hasFile: boolean;
	/** A file recipe runs only once the person approved this exact content. */
	approved: boolean;
}

export interface WorktreeRecipeResult {
	success: boolean;
	data?: WorktreeRecipeState;
	error?: string;
}
