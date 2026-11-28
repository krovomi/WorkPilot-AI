/**
 * Whether this machine starts an MCP server that must run confined (#369,
 * lot 6). The backend decides it when it starts the server
 * (`core.mcp_confinement`); the app asks the same function through
 * `runners/mcp_sandbox_runner.py`, so the marketplace and Agent Tools name
 * the reason next to each confined server instead of a silent refusal. No
 * second detector here: the main has no sandbox of its own.
 *
 * What the runner prints is read back field by field (zod). An answer is
 * kept for the life of the app (the probe runs a sandbox once); "recheck"
 * asks again. A failure to ask is `unknown` and is not kept.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import { z } from "zod";
import type { McpSandboxStatus } from "../../shared/types/mcp-sandbox";
import { appLog } from "../app-logger";
import { parsePythonCommand } from "../python-detector";
import { readyPythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

export const SANDBOX_RUNNER = "mcp_sandbox_runner.py";
const RUNNER_TIMEOUT_MS = 60_000;
const MAX_TEXT = 500;

const text = (max: number) =>
	z
		.string()
		.nullable()
		.transform((value) => (value === null ? null : value.slice(0, max)));

const ProbeSchema = z.object({
	available: z.boolean(),
	kind: z.enum(["available", "off", "unsupported", "missing", "refused"]),
	backend: text(64),
	reason: text(MAX_TEXT),
});

/** What the runner answered, as `{ stdout }`, or why it could not run. */
export type ProbeOutput = { stdout: string } | { error: string };
export type ProbeRunner = () => Promise<ProbeOutput>;

function unknown(reason: string): McpSandboxStatus {
	return { available: false, kind: "unknown", backend: null, reason: reason.slice(0, MAX_TEXT) };
}

/** The status in the runner's output (its last JSON line), or `unknown`. */
export function parseSandboxProbe(output: ProbeOutput): McpSandboxStatus {
	if ("error" in output) return unknown(output.error);
	for (const line of output.stdout.trim().split(/\r?\n/).reverse()) {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			continue;
		}
		const parsed = ProbeSchema.safeParse(raw);
		if (!parsed.success) break;
		// An answer that says it is available and names a reason, or the
		// reverse, is not one the backend gives: taken at its word on
		// `available` only, so "available" never hides a refusal.
		const { available, kind, backend, reason } = parsed.data;
		if (available !== (kind === "available")) break;
		return { available, kind, backend, reason };
	}
	return unknown("The sandbox check gave no answer");
}

/** `{ refresh }` from the renderer, or null when it is not one. */
export function parseSandboxRequest(request: unknown): { refresh: boolean } | null {
	if (request === undefined || request === null) return { refresh: false };
	if (typeof request !== "object" || Array.isArray(request)) return null;
	const { refresh, ...rest } = request as Record<string, unknown>;
	if (Object.keys(rest).length > 0) return null;
	if (refresh !== undefined && typeof refresh !== "boolean") return null;
	return { refresh: refresh === true };
}

/** The status, probed once and kept; `unknown` is asked again next time. */
export class SandboxStatusCache {
	private pending: Promise<McpSandboxStatus> | null = null;

	constructor(private readonly run: ProbeRunner) {}

	get(refresh = false): Promise<McpSandboxStatus> {
		if (!this.pending || refresh) {
			const asked = this.run()
				.catch((error: unknown) => ({
					error: error instanceof Error ? error.message : "The sandbox check failed",
				}))
				.then(parseSandboxProbe);
			this.pending = asked;
			void asked.then((status) => {
				if (status.kind === "unknown" && this.pending === asked) this.pending = null;
			});
		}
		return this.pending;
	}
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** Runs the backend's runner, by its path, without a shell. */
export async function runSandboxRunner(): Promise<ProbeOutput> {
	const pythonPath = await readyPythonPath();
	if (!pythonPath) return { error: "Python environment not ready" };
	const backend = backendPath();
	const env = await pythonRunnerEnv(backend);
	const [exe, baseArgs] = parsePythonCommand(pythonPath);
	return new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exe, [...baseArgs, path.join(backend, "runners", SANDBOX_RUNNER)], {
				cwd: backend,
				env,
			});
		} catch (error) {
			resolve({ error: error instanceof Error ? error.message : "Failed to start" });
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			resolve({ error: "The sandbox check timed out" });
		}, RUNNER_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appLog.debug("[MCP sandbox]", chunk.toString().trim());
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ error: error.message });
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve({ stdout });
		});
	});
}

let cache: SandboxStatusCache | null = null;

/** The machine's answer for the whole app. */
export function mcpSandboxStatus(refresh = false): Promise<McpSandboxStatus> {
	cache ??= new SandboxStatusCache(runSandboxRunner);
	return cache.get(refresh);
}
