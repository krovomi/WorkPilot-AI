/**
 * Guardrails IPC Handlers
 *
 * The rules edited in the app live in <projectPath>/.workpilot/guardrails.json
 * (one of the three layers the backend reads, see
 * apps/backend/security/guardrail_policy.py). Everything that *judges* — the
 * tester, the validation, the dry run over the current changes — goes through
 * the Python runner, the one implementation the agents are held to: a second
 * copy here drifted from it (JavaScript and Python regexes differ, and the
 * semantic conditions only exist in Python).
 *
 * Channels:
 *   guardrails:load       → { projectPath } → GuardrailsDoc
 *   guardrails:save       → { projectPath, doc } → true
 *   guardrails:test       → { projectPath, toolName, toolInput } → TestResult
 *   guardrails:validate   → { projectPath } → PolicyReport
 *   guardrails:activity   → { projectPath } → Activity
 *   guardrails:answer     → { projectPath, requestId, approve } → Approval
 *   guardrails:checkDiff  → { projectPath, ref? } → DiffCheck
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

export interface GuardrailRuleDoc {
	id: string;
	description: string;
	action: "allow" | "warn" | "deny" | "require_approval";
	message?: string;
	when: {
		tool?: string | string[];
		path_prefix?: string;
		path_regex?: string;
		path_glob?: string;
		content_regex?: string;
		command_pattern?: string;
		content_max_lines?: number;
		content_max_bytes?: number;
		forbidden_strings?: string[];
		new_file_max_lines?: number;
		adds_regex?: string;
		deletes_tests?: boolean;
		adds_dependency?: boolean;
		branch?: string | string[];
	};
}

export interface GuardrailsDoc {
	version: number;
	rules: GuardrailRuleDoc[];
}

const RESULT_PREFIX = "GUARDRAILS_RESULT:";
const ERROR_PREFIX = "GUARDRAILS_ERROR:";
const REQUEST_ID = /^[0-9a-f]{12}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,199}$/;
const RUNNER_TIMEOUT_MS = 120_000;

/** A project path the renderer sent, checked before it reaches a file or a process. */
export function checkedProjectPath(projectPath: unknown): string {
	if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) {
		throw new Error("projectPath must be an absolute path");
	}
	if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
		throw new Error("projectPath is not a folder");
	}
	return projectPath;
}

/** The runner arguments of a guardrails call, revalidated in the main process. */
export function guardrailsRunnerArgs(command: string, request: Record<string, unknown>): string[] {
	const projectPath = checkedProjectPath(request.projectPath);
	const args = [command, "--project-path", projectPath];
	switch (command) {
		case "validate":
		case "activity":
			return args;
		case "test": {
			const tool = request.toolName;
			if (typeof tool !== "string" || !/^[A-Za-z]{1,40}$/.test(tool)) throw new Error("invalid tool name");
			const input = request.toolInput;
			if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("toolInput must be an object");
			return [...args, "--tool", tool, "--input", JSON.stringify(input)];
		}
		case "answer": {
			const id = request.requestId;
			if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new Error("invalid request id");
			return [...args, "--request", id, request.approve === true ? "--approve" : "--refuse"];
		}
		case "check-diff": {
			const ref = typeof request.ref === "string" && request.ref.trim() ? request.ref.trim() : "HEAD";
			if (!SAFE_REF.test(ref)) throw new Error(`Not a git ref: ${ref}`);
			return [...args, "--ref", ref];
		}
		default:
			throw new Error(`unknown guardrails command ${command}`);
	}
}

/** The runner's answer: the JSON after its result prefix, or its error. */
export function parseRunnerOutput(stdout: string): unknown {
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith(RESULT_PREFIX)) return JSON.parse(trimmed.slice(RESULT_PREFIX.length));
		if (trimmed.startsWith(ERROR_PREFIX)) {
			const raw = trimmed.slice(ERROR_PREFIX.length);
			let message = raw;
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed === "string") message = parsed;
			} catch {
				// plain text from an older runner
			}
			throw new Error(message);
		}
	}
	throw new Error("the guardrails runner gave no answer");
}

async function runGuardrails(command: string, request: unknown): Promise<unknown> {
	const args = guardrailsRunnerArgs(command, (request ?? {}) as Record<string, unknown>);
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runner = path.resolve(backendPath, "runners", "guardrails_runner.py");
	const python = await requirePythonPath();
	const env = await pythonRunnerEnv(backendPath);
	return new Promise((resolve, reject) => {
		const child = spawn(python, [runner, ...args], { cwd: backendPath, env } as Parameters<typeof spawn>[2]);
		let stdout = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), RUNNER_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => console.error("[Guardrails] stderr:", chunk.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new Error(`Failed to start the guardrails runner: ${err.message}`));
		});
		child.on("close", () => {
			clearTimeout(timer);
			try {
				resolve(parseRunnerOutput(stdout));
			} catch (err) {
				reject(err);
			}
		});
	});
}

function getConfigPath(projectPath: string): string {
	return path.join(projectPath, ".workpilot", "guardrails.json");
}

function readDoc(projectPath: string): GuardrailsDoc {
	const p = getConfigPath(projectPath);
	if (!fs.existsSync(p)) return { version: 1, rules: [] };
	const raw = fs.readFileSync(p, "utf-8");
	let parsed: Partial<GuardrailsDoc>;
	try {
		parsed = JSON.parse(raw) as Partial<GuardrailsDoc>;
	} catch (err) {
		// Never an empty list: saving it would erase the person's rules.
		throw new Error(`guardrails.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!Array.isArray(parsed.rules)) throw new Error("guardrails.json has no 'rules' list");
	return { version: parsed.version ?? 1, rules: parsed.rules };
}

function writeDoc(projectPath: string, doc: GuardrailsDoc): void {
	const p = getConfigPath(projectPath);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(doc, null, 2), "utf-8");
}

export function registerGuardrailsHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.GUARDRAILS_LOAD, async (_evt, request: { projectPath?: unknown }) =>
		readDoc(checkedProjectPath(request?.projectPath)),
	);

	ipcMain.handle(IPC_CHANNELS.GUARDRAILS_SAVE, async (_evt, request: { projectPath?: unknown; doc?: unknown }) => {
		const doc = request?.doc as GuardrailsDoc | undefined;
		if (!doc || !Array.isArray(doc.rules)) throw new Error("doc.rules must be a list");
		writeDoc(checkedProjectPath(request?.projectPath), { version: doc.version ?? 1, rules: doc.rules });
		return true;
	});

	ipcMain.handle(IPC_CHANNELS.GUARDRAILS_TEST, (_evt, request: unknown) => runGuardrails("test", request));
	ipcMain.handle(IPC_CHANNELS.GUARDRAILS_VALIDATE, (_evt, request: unknown) => runGuardrails("validate", request));
	ipcMain.handle(IPC_CHANNELS.GUARDRAILS_ACTIVITY, (_evt, request: unknown) => runGuardrails("activity", request));
	ipcMain.handle(IPC_CHANNELS.GUARDRAILS_ANSWER, (_evt, request: unknown) => runGuardrails("answer", request));
	ipcMain.handle(IPC_CHANNELS.GUARDRAILS_CHECK_DIFF, (_evt, request: unknown) => runGuardrails("check-diff", request));
}
