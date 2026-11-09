/**
 * The API Watcher runner's arguments, built in main from what the renderer
 * sent (S6, #389): the mode is one of two, the target branch is checked and
 * never reaches the runner as an option.
 */

export interface RunRequest {
	projectPath: string;
	saveBaseline?: boolean;
	mode?: unknown;
	target?: unknown;
}

/** A branch name the renderer sent (S6): never an option, no `..`. */
const TARGET_REF = /^[\w][\w./@-]{0,199}$/;

export function runnerArgs(request: RunRequest): string[] {
	const args = ["--project-path", request.projectPath];
	if (request.saveBaseline || request.mode === "baseline") {
		args.push("--mode", "baseline");
		if (request.saveBaseline) args.push("--save-baseline");
		return args;
	}
	const target = typeof request.target === "string" ? request.target.trim() : "";
	if (target) {
		if (!TARGET_REF.test(target) || target.includes("..")) {
			throw new Error("Invalid target branch");
		}
		args.push("--target", target);
	}
	return args;
}
