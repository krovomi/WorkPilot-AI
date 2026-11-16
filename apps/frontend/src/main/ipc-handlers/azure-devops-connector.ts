/**
 * The Azure DevOps connector, called through
 * `apps/backend/runners/azure_devops/connector_call.py`: the runner is a file
 * of the backend, and every value (project folder, operation, parameters)
 * reaches it as an argument, never as part of its source. Its environment
 * holds no credential but the project's own Azure DevOps settings.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { getEffectiveSourcePath } from "../updater/path-resolver";
import { envWithoutCredentials } from "../utils/child-env";
import { connectorsRoot } from "../utils/connectors-path";

/** The backend folder, in the repository or in the installed app. */
const backendPath = path.resolve(import.meta.dirname, "..", "..", "..", "backend");

/** What the connector runner can do. */
export type AzureDevOpsOperation =
	| "test_connection"
	| "list_work_items"
	| "get_work_item"
	| "list_repositories"
	| "detect_repository";

/** The arguments of one call: the runner, then values only. */
export function azureDevOpsCallArgs(
	projectDir: string,
	operation: AzureDevOpsOperation,
	params: Record<string, unknown>,
): string[] {
	return [
		path.join(backendPath, "runners", "azure_devops", "connector_call.py"),
		connectorsRoot(getEffectiveSourcePath()),
		projectDir,
		operation,
		JSON.stringify(params),
	];
}

/**
 * Runs one operation in `projectDir` and gives its data; a refusal or a
 * failure rejects with the runner's message.
 */
export function callAzureDevOpsPython(
	projectDir: string,
	operation: AzureDevOpsOperation,
	params: Record<string, unknown> = {},
	envOverrides: Record<string, string> = {},
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const proc = spawn("python", azureDevOpsCallArgs(projectDir, operation, params), {
			cwd: projectDir,
			env: envWithoutCredentials(process.env, { PYTHONIOENCODING: "utf-8", ...envOverrides }),
		});
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			let answer: { data?: unknown; error?: string } | undefined;
			try {
				const text = stdout.trim();
				answer = JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
			} catch {
				answer = undefined;
			}
			if (answer?.error) {
				reject(new Error(answer.error));
			} else if (code === 0 && answer) {
				resolve(answer.data);
			} else {
				const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
				reject(new Error(output || `Process exited with code ${code}`));
			}
		});
		proc.on("error", reject);
	});
}
