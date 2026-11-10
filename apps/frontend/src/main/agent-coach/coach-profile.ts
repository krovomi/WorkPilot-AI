/**
 * The personal style profile of the agent coach (#376).
 *
 * `coach_profile_runner.py` reads and writes `.workpilot/coach/` in the
 * project; nothing here touches the project's files. What the renderer sends
 * is checked first (S6): a project path (also checked by `ipc-path-policy`),
 * preferences from closed lists, a task name. The runner checks them again.
 * An export is written where the person chose in a native dialog; an import
 * is read from a file chosen the same way, at most 256 KB.
 */
import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type CoachCheckResult,
	type CoachProfileState,
	STYLE_DIMENSIONS,
	STYLE_LANGUAGES,
	type StyleDimension,
	type StyleOverrides,
	type StylePreferences,
} from "../../shared/types/agent-coach";
import { showOpenDialog, showSaveDialog } from "../electron-utils";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const ERROR_PREFIX = "COACH_ERROR:";
const TIMEOUT_MS = 3 * 60_000;
export const MAX_IMPORT_BYTES = 256 * 1024;
const SPEC = /^[A-Za-z0-9][\w.-]{0,119}$/;
const LANGUAGES = new Set<string>(STYLE_LANGUAGES);

export type CoachAction = "get" | "build" | "set" | "export" | "import" | "check";
export type RunCoach = <T>(
	projectPath: string,
	action: CoachAction,
	prefix: string,
	options?: { spec?: string; stdin?: string },
) => Promise<T>;

export function readProjectPath(raw: unknown): string | null {
	if (!raw || typeof raw !== "object") return null;
	const value = (raw as Record<string, unknown>).projectPath;
	return typeof value === "string" && value.length > 0 && value.length < 4096 ? value : null;
}

/** Known languages, dimensions and values (or "off"), nothing else. */
export function readOverrides(raw: unknown): StyleOverrides {
	const overrides: StyleOverrides = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return overrides;
	for (const [language, dims] of Object.entries(raw as Record<string, unknown>)) {
		if (!LANGUAGES.has(language) || !dims || typeof dims !== "object" || Array.isArray(dims)) continue;
		const kept: Partial<Record<StyleDimension, string>> = {};
		for (const [dim, value] of Object.entries(dims as Record<string, unknown>)) {
			if (!(dim in STYLE_DIMENSIONS) || typeof value !== "string") continue;
			const values: readonly string[] = STYLE_DIMENSIONS[dim as StyleDimension];
			if (value === "off" || values.includes(value)) kept[dim as StyleDimension] = value;
		}
		if (Object.keys(kept).length > 0) overrides[language as keyof StyleOverrides] = kept;
	}
	return overrides;
}

export function readPreferences(raw: unknown): StylePreferences | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	return { enabled: r.enabled !== false, overrides: readOverrides(r.overrides) };
}

export function readSpec(raw: unknown): string | null {
	if (!raw || typeof raw !== "object") return null;
	const spec = (raw as Record<string, unknown>).spec;
	return typeof spec === "string" && SPEC.test(spec) ? spec : null;
}

export const runCoach: RunCoach = async <T>(
	projectPath: string,
	action: CoachAction,
	prefix: string,
	options: { spec?: string; stdin?: string } = {},
): Promise<T> => {
	const { app } = await import("electron");
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runner = path.resolve(backendPath, "runners", "coach_profile_runner.py");
	const args = [runner, "--project-path", projectPath, "--action", action];
	if (options.spec) args.push("--spec", options.spec);
	const python = await requirePythonPath();
	const env = await pythonRunnerEnv(backendPath);
	return new Promise<T>((resolve, reject) => {
		const child = spawn(python, args, { cwd: backendPath, env });
		const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => console.error("[CoachProfile]", chunk.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const lines = out.split("\n").map((l) => l.trim());
			const error = lines.find((l) => l.startsWith(ERROR_PREFIX));
			const result = lines.find((l) => l.startsWith(prefix));
			if (code !== 0 || !result) {
				reject(new Error(error?.slice(ERROR_PREFIX.length) || `coach profile runner exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(result.slice(prefix.length)) as T);
			} catch (err) {
				reject(err);
			}
		});
		child.stdin?.end(options.stdin ?? "");
	});
};

export function getProfile(projectPath: string, run: RunCoach = runCoach): Promise<CoachProfileState> {
	return run<CoachProfileState>(projectPath, "get", "COACH_PROFILE:");
}

export function buildProfile(projectPath: string, run: RunCoach = runCoach): Promise<CoachProfileState> {
	return run<CoachProfileState>(projectPath, "build", "COACH_PROFILE:");
}

export function setPreferences(
	projectPath: string,
	preferences: StylePreferences,
	run: RunCoach = runCoach,
): Promise<CoachProfileState> {
	return run<CoachProfileState>(projectPath, "set", "COACH_PROFILE:", { stdin: JSON.stringify(preferences) });
}

export function checkTask(projectPath: string, spec: string, run: RunCoach = runCoach): Promise<CoachCheckResult> {
	return run<CoachCheckResult>(projectPath, "check", "COACH_CHECK:", { spec });
}

/** Writes the export where the person chose; null when they cancelled. */
export async function exportProfile(projectPath: string, run: RunCoach = runCoach): Promise<string | null> {
	const data = await run<unknown>(projectPath, "export", "COACH_EXPORT:");
	const { canceled, filePath } = await showSaveDialog({
		defaultPath: "workpilot-coach-profile.json",
		filters: [{ name: "JSON", extensions: ["json"] }],
	});
	if (canceled || !filePath) return null;
	await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	return filePath;
}

/** Reads a file the person chose and hands it to the runner, which validates it; null when cancelled. */
export async function importProfile(projectPath: string, run: RunCoach = runCoach): Promise<CoachProfileState | null> {
	const { canceled, filePaths } = await showOpenDialog({
		properties: ["openFile"],
		filters: [{ name: "JSON", extensions: ["json"] }],
	});
	const file = filePaths?.[0];
	if (canceled || !file) return null;
	return run<CoachProfileState>(projectPath, "import", "COACH_PROFILE:", { stdin: await readImport(file) });
}

/** Checks and reads through one handle, so the file checked is the file read; never more than the cap. */
async function readImport(file: string): Promise<string> {
	const handle = await open(file, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_IMPORT_BYTES) throw new Error("The file is not a coach profile");
		const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		if (total > MAX_IMPORT_BYTES) throw new Error("The file is not a coach profile");
		return buffer.toString("utf-8", 0, total);
	} finally {
		await handle.close();
	}
}
