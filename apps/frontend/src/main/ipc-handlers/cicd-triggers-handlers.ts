/**
 * CI/CD Deployment Triggers IPC Handlers (Feature 44)
 *
 * Exposes channels for triggering deployment pipelines after agent PRs:
 *   cicdTriggers:getConfig      — Current trigger configuration per provider
 *   cicdTriggers:setConfig      — Update trigger configuration
 *   cicdTriggers:listRuns       — Recent pipeline run history
 *   cicdTriggers:trigger        — Manually trigger a pipeline for a PR
 *   cicdTriggers:getRunStatus   — Get status of a specific pipeline run
 *   cicdTriggers:cancelRun      — Cancel a running pipeline
 *
 * Supported providers: GitHub Actions, GitLab CI, Azure DevOps Pipelines, Jenkins
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ipcMain } from "electron";
import type { Project } from "../../shared/types";
import {
	getProjectEnvPath,
	readProjectEnv,
	writeProjectEnvFile,
} from "../project-env-file";
import { ensureProjectEnvIgnored } from "../project-initializer";
import { projectStore } from "../project-store";
import { parsePythonCommand } from "../python-detector";
import { getConfiguredPythonPath } from "../python-env-manager";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getRunnerPath(): string {
	return path.join(
		__dirname,
		"..",
		"..",
		"..",
		"..",
		"..",
		"apps",
		"backend",
		"runners",
		"cicd_triggers_runner.py",
	);
}

/**
 * The project a renderer-supplied directory names, or null. The renderer is
 * not trusted (rule S6): a directory that is not one of the user's projects
 * is refused before anything is read, written or spawned there.
 */
export function findKnownProject(projectDir: unknown): Project | null {
	if (typeof projectDir !== "string" || projectDir === "") return null;
	const wanted = path.resolve(projectDir);
	return (
		projectStore.getProjects().find((p) => path.resolve(p.path) === wanted) ??
		null
	);
}

const UNKNOWN_PROJECT = { success: false, error: "Project not found" } as const;

/** Renderer field → `.workpilot/.env` key. Nothing outside this list is written. */
export const CICD_CONFIG_KEYS: Readonly<Record<string, string>> = {
	provider: "CICD_PROVIDER",
	enabled: "CICD_AUTO_TRIGGER",
	trigger_on_pr: "CICD_TRIGGER_ON_PR",
	trigger_on_merge: "CICD_TRIGGER_ON_MERGE",
	github_token: "CICD_GITHUB_TOKEN",
	github_workflow: "CICD_GITHUB_WORKFLOW",
	github_ref: "CICD_GITHUB_REF",
	gitlab_token: "CICD_GITLAB_TOKEN",
	gitlab_project_id: "CICD_GITLAB_PROJECT_ID",
	gitlab_ref: "CICD_GITLAB_REF",
	azure_token: "CICD_AZURE_TOKEN",
	azure_org: "CICD_AZURE_ORG",
	azure_project: "CICD_AZURE_PROJECT",
	azure_pipeline_id: "CICD_AZURE_PIPELINE_ID",
	jenkins_url: "CICD_JENKINS_URL",
	jenkins_token: "CICD_JENKINS_TOKEN",
	jenkins_job: "CICD_JENKINS_JOB",
};

/** What getConfig shows for a token that is set; sent back, it means "unchanged". */
export const MASKED_TOKEN = "***";

/** The CI/CD settings of a project, tokens decrypted — main process only. */
function readCicdConfig(project: Project): Record<string, string> {
	const vars = readProjectEnv(withAutoBuildPath(project));
	return Object.fromEntries(
		Object.entries(vars).filter(([key]) => key.startsWith("CICD_")),
	);
}

/**
 * `.workpilot/.env` keys and values to write for a renderer config, or an
 * error. Unknown fields are ignored; a value spanning lines is refused, since
 * one would add arbitrary variables to the file and to the runner's env.
 */
export function toCicdEnvUpdate(
	config: unknown,
): { ok: true; update: Record<string, string> } | { ok: false; error: string } {
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		return { ok: false, error: "invalid-config" };
	}
	const update: Record<string, string> = {};
	for (const [field, raw] of Object.entries(config)) {
		const key = CICD_CONFIG_KEYS[field];
		if (!key) continue;
		const value = String(raw ?? "");
		if (/[\r\n\0]/.test(value)) return { ok: false, error: "invalid-value" };
		if (key.endsWith("_TOKEN") && value === MASKED_TOKEN) continue;
		update[key] = value;
	}
	return { ok: true, update };
}

/** `content` with each key's line replaced, or appended when absent. */
export function applyEnvUpdate(
	content: string,
	update: Record<string, string>,
): string {
	let result = content;
	for (const [key, value] of Object.entries(update)) {
		const line = `${key}=${value}`;
		const existing = new RegExp(`^${key}=.*$`, "m");
		result = existing.test(result)
			? result.replace(existing, () => line)
			: `${result.trimEnd()}\n${line}\n`;
	}
	return result.startsWith("\n") ? result.slice(1) : result;
}

/** The project with its `.workpilot` directory, initialized or not yet. */
function withAutoBuildPath(project: Project): Project {
	return { ...project, autoBuildPath: project.autoBuildPath || ".workpilot" };
}

async function writeCicdConfig(
	project: Project,
	update: Record<string, string>,
): Promise<void> {
	const located = withAutoBuildPath(project);
	const envPath = getProjectEnvPath(located) as string;
	let current = "";
	try {
		// As stored: `enc:` values stay as they are, encoding is idempotent.
		current = fs.readFileSync(envPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	writeProjectEnvFile(envPath, applyEnvUpdate(current, update));
	await ensureProjectEnvIgnored(project.path, located.autoBuildPath as string);
}

async function runRunner(
	project: Project,
	args: string[],
): Promise<{ success: boolean; data?: unknown; error?: string }> {
	const pythonPath = getConfiguredPythonPath();
	const [cmd, pythonBaseArgs] = parsePythonCommand(pythonPath);
	const cmdArgs = [...pythonBaseArgs, getRunnerPath(), ...args];

	return new Promise((resolve) => {
		// Only the CI/CD settings, decrypted: the project's files are never
		// spread whole into the child's environment.
		const env = {
			...process.env,
			...readCicdConfig(project),
		} as Record<string, string>;

		const proc = spawn(cmd, cmdArgs, { env, cwd: project.path });
		const stdout: string[] = [];
		const stderr: string[] = [];
		proc.stdout?.on("data", (d: Buffer) => stdout.push(d.toString()));
		proc.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));

		proc.on("close", (code) => {
			const out = stdout.join("").trim();
			if (code === 0) {
				try {
					resolve({ success: true, data: JSON.parse(out) });
				} catch {
					resolve({ success: true, data: { message: out } });
				}
			} else {
				resolve({ success: false, error: stderr.join("").trim() || out });
			}
		});
		proc.on("error", (err) => resolve({ success: false, error: err.message }));
	});
}

function getRunsLogPath(projectDir: string): string {
	return path.join(projectDir, ".workpilot", "cicd_runs.json");
}

function loadRuns(projectDir: string): object[] {
	const logPath = getRunsLogPath(projectDir);
	if (!fs.existsSync(logPath)) return [];
	try {
		return JSON.parse(fs.readFileSync(logPath, "utf-8"));
	} catch {
		return [];
	}
}

function saveRun(projectDir: string, run: object): void {
	const runs = loadRuns(projectDir);
	runs.unshift(run);
	// Keep last 200 runs
	const trimmed = runs.slice(0, 200);
	fs.mkdirSync(path.dirname(getRunsLogPath(projectDir)), { recursive: true });
	fs.writeFileSync(
		getRunsLogPath(projectDir),
		JSON.stringify(trimmed, null, 2),
		"utf-8",
	);
}

export function registerCICDTriggersHandlers(): void {
	ipcMain.handle("cicdTriggers:getConfig", (_event, projectDir: unknown) => {
		const project = findKnownProject(projectDir);
		if (!project) return UNKNOWN_PROJECT;
		try {
			const cfg = readCicdConfig(project);
			return {
				success: true,
				data: {
					provider: cfg.CICD_PROVIDER ?? "",
					enabled: cfg.CICD_AUTO_TRIGGER === "true",
					trigger_on_pr: cfg.CICD_TRIGGER_ON_PR !== "false",
					trigger_on_merge: cfg.CICD_TRIGGER_ON_MERGE !== "false",
					// GitHub Actions
					github_token: cfg.CICD_GITHUB_TOKEN ? "***" : "",
					github_workflow: cfg.CICD_GITHUB_WORKFLOW ?? "",
					github_ref: cfg.CICD_GITHUB_REF ?? "main",
					// GitLab CI
					gitlab_token: cfg.CICD_GITLAB_TOKEN ? "***" : "",
					gitlab_project_id: cfg.CICD_GITLAB_PROJECT_ID ?? "",
					gitlab_ref: cfg.CICD_GITLAB_REF ?? "main",
					// Azure DevOps
					azure_token: cfg.CICD_AZURE_TOKEN ? "***" : "",
					azure_org: cfg.CICD_AZURE_ORG ?? "",
					azure_project: cfg.CICD_AZURE_PROJECT ?? "",
					azure_pipeline_id: cfg.CICD_AZURE_PIPELINE_ID ?? "",
					// Jenkins
					jenkins_url: cfg.CICD_JENKINS_URL ?? "",
					jenkins_token: cfg.CICD_JENKINS_TOKEN ? "***" : "",
					jenkins_job: cfg.CICD_JENKINS_JOB ?? "",
				},
			};
		} catch (err) {
			return { success: false, error: String(err) };
		}
	});

	ipcMain.handle(
		"cicdTriggers:setConfig",
		async (_event, projectDir: unknown, config: unknown) => {
			const project = findKnownProject(projectDir);
			if (!project) return UNKNOWN_PROJECT;
			const parsed = toCicdEnvUpdate(config);
			if (!parsed.ok) return { success: false, error: parsed.error };
			try {
				// Encrypted in .workpilot/.env (0600 + banner without a keyring).
				await writeCicdConfig(project, parsed.update);
				return { success: true };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);

	ipcMain.handle(
		"cicdTriggers:listRuns",
		(_event, projectDir: unknown, limit: number = 50) => {
			const project = findKnownProject(projectDir);
			if (!project) return UNKNOWN_PROJECT;
			try {
				const runs = loadRuns(project.path).slice(0, limit);
				return { success: true, data: runs };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);

	ipcMain.handle(
		"cicdTriggers:trigger",
		async (
			_event,
			projectDir: unknown,
			params: {
				provider: string;
				pr_url?: string;
				branch?: string;
				workflow?: string;
				ref?: string;
			},
		) => {
			const project = findKnownProject(projectDir);
			if (!project) return UNKNOWN_PROJECT;
			const run = {
				id: Date.now().toString(),
				triggered_at: new Date().toISOString(),
				status: "pending",
				provider: params.provider,
				pr_url: params.pr_url ?? "",
				branch: params.branch ?? "",
			};
			saveRun(project.path, run);

			const result = await runRunner(project, [
				"--action",
				"trigger",
				"--provider",
				params.provider,
				"--project",
				project.path,
				...(params.pr_url ? ["--pr-url", params.pr_url] : []),
				...(params.branch ? ["--branch", params.branch] : []),
				...(params.workflow ? ["--workflow", params.workflow] : []),
				"--output-json",
			]);

			// Update run status
			const runs = loadRuns(project.path);
			const idx = runs.findIndex(
				(r: unknown) => (r as { id: string }).id === run.id,
			);
			if (idx >= 0) {
				(runs[idx] as Record<string, unknown>).status = result.success
					? "triggered"
					: "failed";
				(runs[idx] as Record<string, unknown>).error = result.success
					? undefined
					: result.error;
				(runs[idx] as Record<string, unknown>).run_data = result.data;
				fs.writeFileSync(
					getRunsLogPath(project.path),
					JSON.stringify(runs, null, 2),
					"utf-8",
				);
			}

			return result;
		},
	);

	ipcMain.handle(
		"cicdTriggers:getRunStatus",
		async (_event, projectDir: unknown, runId: string) => {
			const project = findKnownProject(projectDir);
			if (!project) return UNKNOWN_PROJECT;
			return runRunner(project, [
				"--action",
				"status",
				"--run-id",
				runId,
				"--project",
				project.path,
				"--output-json",
			]);
		},
	);

	ipcMain.handle(
		"cicdTriggers:cancelRun",
		async (_event, projectDir: unknown, runId: string) => {
			const project = findKnownProject(projectDir);
			if (!project) return UNKNOWN_PROJECT;
			return runRunner(project, [
				"--action",
				"cancel",
				"--run-id",
				runId,
				"--project",
				project.path,
				"--output-json",
			]);
		},
	);
}
