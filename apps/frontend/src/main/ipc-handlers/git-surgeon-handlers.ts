/**
 * Git History Surgeon IPC handlers (#360).
 *
 * Every channel takes a project the person added (`resolveKnownProject`, S6)
 * and checked values only (`main/git-surgeon/input.ts`). A plan or a branch
 * list goes to the runner through a temporary file, never the command line;
 * the runner runs without a shell (S4).
 *
 *   invoke "gitSurgeon:run"            → { projectPath, maxCommits? }  history scan
 *   invoke "gitSurgeon:plan"           → { projectPath, base?, ai? }    rewrite plan
 *   invoke "gitSurgeon:apply"          → { projectPath, plan }          new branch
 *   invoke "gitSurgeon:branches"       → { projectPath }
 *   invoke "gitSurgeon:deleteBranches" → { projectPath, names }         merged only
 *   invoke "gitSurgeon:history"        → { projectPath }
 *   invoke "gitSurgeon:cancel"         → void
 *
 * Renderer events: git-surgeon-event, git-surgeon-result, git-surgeon-error
 * (the history scan, as before).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { readBranchNames, readPlanInput, readRevision } from "../git-surgeon/input";
import { resolveKnownProject } from "../security/renderer-path";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

type Args = Record<string, unknown> | undefined;

const EVENT_PREFIX = "GIT_SURGEON_EVENT:";
const RESULT_PREFIX = "GIT_SURGEON_RESULT:";
const ERROR_PREFIX = "GIT_SURGEON_ERROR:";

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, payload);
	}
}

function project(args: Args): string {
	const root = resolveKnownProject(args?.projectPath);
	if (!root) throw new Error("Not a project of this app");
	return root;
}

interface Run {
	child: ChildProcess;
	result: Promise<unknown>;
}

async function runSurgeon(projectRoot: string, args: string[], onEvent?: (payload: unknown) => void): Promise<Run> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(backendPath, "runners", "git_surgeon_runner.py");
	const child = spawn(await requirePythonPath(), [runnerPath, "--project-path", projectRoot, ...args], {
		cwd: backendPath,
		env: await pythonRunnerEnv(backendPath),
	} as Parameters<typeof spawn>[2]);

	let buffer = "";
	let result: unknown = null;
	let errorMessage: string | null = null;
	const readLine = (line: string) => {
		if (line.startsWith(EVENT_PREFIX)) {
			try {
				onEvent?.(JSON.parse(line.slice(EVENT_PREFIX.length)));
			} catch (err) {
				console.error("[GitSurgeon] Bad event line:", err);
			}
		} else if (line.startsWith(RESULT_PREFIX)) {
			try {
				result = JSON.parse(line.slice(RESULT_PREFIX.length));
			} catch (err) {
				console.error("[GitSurgeon] Bad result line:", err);
			}
		} else if (line.startsWith(ERROR_PREFIX)) {
			const raw = line.slice(ERROR_PREFIX.length);
			try {
				const parsed: unknown = JSON.parse(raw);
				errorMessage = typeof parsed === "string" ? parsed : raw;
			} catch {
				errorMessage = raw;
			}
		}
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line) readLine(line);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		console.error("[GitSurgeon] stderr:", chunk.toString());
	});
	const done = new Promise<unknown>((resolve, reject) => {
		child.on("close", (code) => {
			if (code === 0 && result) resolve(result);
			else reject(new Error(errorMessage ?? `git surgeon runner exited with code ${code}`));
		});
		child.on("error", (err) => reject(new Error(`Failed to start git surgeon runner: ${err.message}`)));
	});
	return { child, result: done };
}

/** Runs with `data` written to a temporary JSON file only this user can read. */
async function withInputFile(data: unknown, run: (file: string) => Promise<unknown>): Promise<unknown> {
	const folder = await mkdtemp(path.join(os.tmpdir(), "wp-surgeon-"));
	const file = path.join(folder, "input.json");
	try {
		await writeFile(file, JSON.stringify(data), { encoding: "utf-8", mode: 0o600 });
		return await run(file);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

export function registerGitSurgeonHandlers(): void {
	let currentProcess: ChildProcess | null = null;

	const killExisting = (): void => {
		currentProcess?.kill("SIGTERM");
		currentProcess = null;
	};

	/** `long`: the scan and the plan, the runs Cancel stops (a replay always ends, cleaning up). */
	const run = async (root: string, args: string[], long = false, scan = false): Promise<unknown> => {
		const handle = await runSurgeon(
			root,
			args,
			scan ? (payload) => broadcast(IPC_CHANNELS.GIT_SURGEON_EVENT, payload) : undefined,
		);
		if (long) currentProcess = handle.child;
		try {
			return await handle.result;
		} finally {
			if (currentProcess === handle.child) currentProcess = null;
		}
	};

	ipcMain.handle(IPC_CHANNELS.GIT_SURGEON_RUN, async (_event, args: Args) => {
		killExisting();
		try {
			const root = project(args);
			const raw = args?.maxCommits;
			const maxCommits = typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= 5000 ? raw : 500;
			const result = await run(root, ["--max-commits", String(maxCommits)], true, true);
			broadcast(IPC_CHANNELS.GIT_SURGEON_RESULT, result);
			return result;
		} catch (err) {
			broadcast(IPC_CHANNELS.GIT_SURGEON_ERROR, err instanceof Error ? err.message : String(err));
			throw err;
		}
	});

	ipcMain.handle(IPC_CHANNELS.GIT_SURGEON_PLAN, async (_event, args: Args) => {
		const root = project(args);
		const runArgs = ["--plan"];
		if (args?.base !== undefined && args.base !== "") {
			const base = readRevision(args.base);
			if (!base) throw new Error("Not a commit or branch name");
			runArgs.push("--base", base);
		}
		if (args?.ai === true) runArgs.push("--ai");
		killExisting();
		return run(root, runArgs, true);
	});

	ipcMain.handle(IPC_CHANNELS.GIT_SURGEON_APPLY, async (_event, args: Args) => {
		const root = project(args);
		const input = readPlanInput(args?.plan);
		if (!input) throw new Error("The plan is not of the known shape");
		killExisting();
		return withInputFile(input, (file) => run(root, ["--apply", file]));
	});

	ipcMain.handle(IPC_CHANNELS.GIT_SURGEON_BRANCHES, async (_event, args: Args) => run(project(args), ["--branches"]));

	ipcMain.handle(IPC_CHANNELS.GIT_SURGEON_DELETE_BRANCHES, async (_event, args: Args) => {
		const root = project(args);
		const names = readBranchNames(args?.names);
		if (!names) throw new Error("Not a list of branch names");
		return withInputFile(names, (file) => run(root, ["--delete-branches", file]));
	});

	ipcMain.handle(IPC_CHANNELS.GIT_SURGEON_HISTORY, async (_event, args: Args) => run(project(args), ["--history"]));

	ipcMain.handle(IPC_CHANNELS.GIT_SURGEON_CANCEL, () => {
		killExisting();
		return true;
	});
}
