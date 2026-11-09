/**
 * One command of the Kanban's quick-command bar, run on a review card.
 *
 * The bar used to ask the desktop backend server to run the command
 * (`POST /api/slash-commands/run`). That server is started once with the
 * main process environment: no Claude profile sign-in, no provider chosen in
 * the app, no key. A Claude subscription (OAuth) was never found ("No OAuth
 * token found… ANTHROPIC_API_KEY not supported"), every other provider was
 * ignored, and the agent wrote straight into the project folder (F181).
 *
 * A command now runs like every page that writes code
 * (docs/architecture/generated-review.md): a Kanban review card is opened,
 * `runners/slash_command_runner.py` runs the command in the card's worktree
 * with the environment of every page runner (`pythonRunnerEnv`: the provider
 * of the app and its key, the Claude profile when the provider needs it), and
 * what the agent wrote is committed on the card's branch. A command that
 * writes nothing (a question, an analysis) leaves no card behind.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { IPCResult } from "../../shared/types";
import type { QuickCommandOutcome, QuickCommandRequest } from "../../shared/types/quick-command";
import { openReviewRun, type ReviewRun } from "../generated-review/review-run";
import { projectStore } from "../project-store";
import { parsePythonCommand } from "../python-detector";
import { getConfiguredPythonPath } from "../python-env-manager";
import { getEffectiveSourcePath } from "../updater/path-resolver";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const RESULT_PREFIX = "__SLASH_COMMAND__:";
/** The runner refuses longer arguments too. */
export const MAX_ARGS_CHARS = 4000;
/** A workflow may take long; an hour is a hung agent. */
const TIMEOUT_MS = 60 * 60 * 1000;
/** What the bar shows of a command's answer. */
const MAX_OUTPUT_CHARS = 20_000;

// The same slug the backend accepts (`slash_commands.api._valid_command_name`).
const COMMAND_NAME = /^[a-zA-Z0-9_./:-]{1,128}$/;

export interface RunnerResult {
	readonly ok: boolean;
	readonly text: string;
}

/** Runs the Python runner; injectable for the tests. */
export type RunSlashCommand = (args: {
	projectPath: string;
	workdir: string;
	command: string;
	args: string;
}) => Promise<RunnerResult>;

export interface QuickCommandDeps {
	readonly open: typeof openReviewRun;
	readonly run: RunSlashCommand;
}

/** A command name, never a path (`../x`, `/etc/x`). */
export function isValidCommandName(command: unknown): command is string {
	return (
		typeof command === "string" &&
		COMMAND_NAME.test(command) &&
		!command.startsWith("/") &&
		!command.split("/").includes("..")
	);
}

/** The runner's result line, or the end of its error output. */
export function parseRunnerOutput(stdout: string, stderr: string): RunnerResult {
	const line = stdout
		.split(/\r?\n/)
		.reverse()
		.find((l) => l.startsWith(RESULT_PREFIX));
	if (!line) {
		const last = stderr.trim().split("\n").pop()?.trim();
		return { ok: false, text: last || "The command runner said nothing" };
	}
	try {
		const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
		if (parsed.success === true) {
			return { ok: true, text: typeof parsed.result === "string" ? parsed.result : "" };
		}
		return {
			ok: false,
			text: typeof parsed.error === "string" && parsed.error ? parsed.error : "The command failed",
		};
	} catch {
		return { ok: false, text: "The command runner answered something unreadable" };
	}
}

export const runSlashCommandRunner: RunSlashCommand = async ({
	projectPath,
	workdir,
	command,
	args,
}) => {
	const backend = getEffectiveSourcePath();
	if (!backend) return { ok: false, text: "WorkPilot AI backend not found" };
	const runner = path.join(backend, "runners", "slash_command_runner.py");
	const [python, baseArgs] = parsePythonCommand(getConfiguredPythonPath());
	// The provider chosen in the app, its key, and the Claude profile's
	// sign-in when the provider runs on it: what the backend server never had.
	const env = await pythonRunnerEnv(backend);
	return new Promise((resolve) => {
		const proc = spawn(
			python,
			[
				...baseArgs,
				runner,
				"--project-dir",
				projectPath,
				"--workdir",
				workdir,
				"--command",
				command,
				"--args",
				args,
			],
			{ cwd: backend, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
		);
		// Only the result line matters: keep it and the line being received,
		// not everything a chatty agent prints.
		let pending = "";
		let resultLine = "";
		let stderr = "";
		let settled = false;
		const settle = (result: RunnerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			proc.kill();
			settle({ ok: false, text: "The command did not finish within an hour and was stopped" });
		}, TIMEOUT_MS);
		proc.stdout?.on("data", (chunk: Buffer) => {
			const lines = (pending + chunk.toString("utf-8")).split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith(RESULT_PREFIX)) resultLine = line;
			}
			if (!pending.startsWith(RESULT_PREFIX.slice(0, pending.length))) pending = "";
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf-8")).slice(-4000);
		});
		proc.on("error", (error) => settle({ ok: false, text: error.message }));
		proc.on("close", () => settle(parseRunnerOutput(`${resultLine}\n${pending}`, stderr)));
	});
};

const defaultDeps: QuickCommandDeps = { open: openReviewRun, run: runSlashCommandRunner };

/** Projects with a command running: one at a time, they share a card. */
const running = new Set<string>();

function cut(text: string): string {
	return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text;
}

export async function runQuickCommand(
	request: QuickCommandRequest,
	deps: QuickCommandDeps = defaultDeps,
): Promise<IPCResult<QuickCommandOutcome>> {
	const { projectId, command } = request ?? ({} as QuickCommandRequest);
	const args = typeof request?.args === "string" ? request.args.trim() : "";
	if (typeof projectId !== "string" || !projectId) {
		return { success: false, error: "No project selected" };
	}
	if (!isValidCommandName(command)) {
		return { success: false, error: "Invalid command name" };
	}
	if (args.length > MAX_ARGS_CHARS) {
		return { success: false, error: `Arguments longer than ${MAX_ARGS_CHARS} characters` };
	}
	// The renderer names a project, never a folder (S6).
	const project = projectStore.getProject(projectId);
	if (!project?.path || project.remote) {
		return {
			success: false,
			error: "Quick commands run on a project of this computer, on a review branch.",
		};
	}
	if (running.has(project.id)) {
		return { success: false, error: "A quick command is already running for this project" };
	}

	running.add(project.id);
	try {
		const label = `/${command}${args ? ` ${args}` : ""}`;
		let review: ReviewRun;
		try {
			review = await deps.open(
				project.path,
				"quick-command",
				label,
				undefined,
				`Quick command: ${label}`,
			);
		} catch (error) {
			const details = (error as { details?: string }).details;
			return {
				success: false,
				error: [error instanceof Error ? error.message : String(error), details]
					.filter(Boolean)
					.join(" "),
			};
		}

		const result = await deps.run({
			projectPath: project.path,
			workdir: review.root,
			command,
			args,
		});

		// Finished or failed: what the agent wrote goes to review either way,
		// and a card it never wrote to goes away (`recordReviewStep`).
		try {
			const settled = await review.finish({
				message: `chore: run /${command} from the quick-command bar`,
				summary: label,
			});
			return {
				success: true,
				data: {
					ok: result.ok,
					output: cut(result.text),
					review: settled.committed ? settled : null,
				},
			};
		} catch (error) {
			return {
				success: true,
				data: {
					ok: result.ok,
					output: cut(
						[result.text, error instanceof Error ? error.message : String(error)]
							.filter(Boolean)
							.join("\n\n"),
					),
					review: null,
					uncommittedIn: review.root,
				},
			};
		}
	} finally {
		running.delete(project.id);
	}
}
