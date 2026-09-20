import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { getOAuthModeClearVars } from "./agent/env-utils";
import { logger } from "./app-logger";
import { parsePythonCommand } from "./python-detector";
import { getConfiguredPythonPath } from "./python-env-manager";
import {
	createSDKRateLimitInfo,
	detectRateLimit,
	getBestAvailableProfileEnv,
	type SDKRateLimitInfo,
} from "./rate-limit-detector";
import { credentialManager } from "./services/credential-manager";
import { getAPIProfileEnv } from "./services/profile";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Marker the runner prints before the raw model output (see runner docstring). */
const RESULT_MARKER = "__ONESHOT_RESULT__:";
/** Marker the runner prints before each JSON-encoded chunk, when streaming. */
const DELTA_MARKER = "__ONESHOT_DELTA__:";
/** Marker the runner prints before the provider's own usage record, if any. */
const USAGE_MARKER = "__ONESHOT_USAGE__:";
/** Marker the runner prints before a redacted failure diagnostic. */
const ERROR_MARKER = "__ONESHOT_ERROR__:";
const ONESHOT_RUNNER = "oneshot_completion_runner.py";
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * What the provider itself reported for a completion. Absent entirely when it
 * reported nothing — the difference between a measurement and a zero is the
 * whole point of the field being optional.
 */
export interface OneShotUsage {
	inputTokens: number;
	outputTokens: number;
	/** The provider's own cost. `0` from a local model is a real answer. */
	costUsd: number;
}

export interface OneShotLLMOptions {
	/** The complete user prompt to send. */
	prompt: string;
	/** Optional system prompt. */
	systemPrompt?: string;
	/**
	 * Run against this provider rather than the active one. The credentials
	 * handed to the subprocess follow it, so naming a provider here is enough
	 * to route the call — the caller does not also have to set the env.
	 */
	provider?: string;
	/** Run against this model (requires a provider that offers it). */
	model?: string;
	/**
	 * Refuse rather than substitute. A provider with no adapter of its own
	 * (mistral, deepseek, grok, meta, aws, cursor, custom) otherwise runs on the
	 * Claude SDK — right for a build, wrong for a caller comparing providers,
	 * which would get an answer labelled with a vendor that never saw the
	 * prompt. The call then fails, with the substitution as its reason.
	 */
	requireProvider?: boolean;
	/** Working directory (enables exotic-provider routing for the runner). */
	projectDir?: string;
	/** Spec directory — used by the runner to resolve the active provider/model. */
	specDir?: string;
	/** Per-call timeout (defaults to 60s). */
	timeoutMs?: number;
	/** Override the Python interpreter (else the configured/venv Python). */
	pythonPath?: string;
	/** Override the backend source directory (else auto-detected). */
	autoBuildSourcePath?: string;
	/** When set, failures are scanned for rate limits and reported via onRateLimit. */
	rateLimitSource?: SDKRateLimitInfo["source"];
	/** Called when a rate limit is detected in a failed run. */
	onRateLimit?: (info: SDKRateLimitInfo) => void;
	/** Short label for log messages. */
	debugLabel?: string;
	/**
	 * Called with each chunk of model text as it arrives, when the provider
	 * streams. Passing it is what turns streaming on in the runner.
	 *
	 * How live this actually is depends on the provider: Copilot / OpenAI /
	 * local models yield many small chunks, while the Claude one-shot client
	 * yields the whole text in a single final message, so this fires once. A
	 * caller must therefore treat it as *earlier* output, never as a promise of
	 * a steady feed — and must still handle everything arriving at the end.
	 */
	onDelta?: (chunk: string) => void;
	/**
	 * Called once with the provider's own usage record, when it reported one.
	 * Never called otherwise, so a caller that needs a number knows when it is
	 * the one estimating.
	 */
	onUsage?: (usage: OneShotUsage) => void;
	/**
	 * Called on failure with a short, already-redacted reason. `runOneShotLLM`
	 * still resolves to null — this is only how a caller that wants to *show*
	 * the failure gets something safe to show.
	 */
	onFailure?: (reason: string) => void;
}

/**
 * Locate the backend source directory (where the runners live). Mirrors the
 * resolution used across the main process: an explicit override, then the
 * packaged-app locations (user-updated `backend-source`, then bundled
 * `resources/backend`), then development paths. The `spec_runner.py` marker
 * confirms it's a real backend checkout.
 */
function resolveBackendSource(override?: string): string | null {
	const hasBackend = (dir: string): boolean =>
		existsSync(dir) && existsSync(path.join(dir, "runners", "spec_runner.py"));

	if (override && hasBackend(override)) return override;

	if (app.isPackaged) {
		const userOverride = path.join(app.getPath("userData"), "backend-source");
		if (hasBackend(userOverride)) return userOverride;
		const resources = path.join(process.resourcesPath, "backend");
		if (hasBackend(resources)) return resources;
	}

	const candidates = [
		path.resolve(__dirname, "..", "..", "..", "backend"),
		path.resolve(app.getAppPath(), "..", "backend"),
		path.resolve(process.cwd(), "apps", "backend"),
	];
	for (const candidate of candidates) {
		if (hasBackend(candidate)) return candidate;
	}
	return null;
}

/** Parse the backend's `.env` into key/value pairs (best-effort). */
function loadAutoBuildEnv(autoBuildSource: string): Record<string, string> {
	const envPath = path.join(autoBuildSource, ".env");
	if (!existsSync(envPath)) return {};
	try {
		const envVars: Record<string, string> = {};
		for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex > 0) {
				const key = trimmed.substring(0, eqIndex).trim();
				let value = trimmed.substring(eqIndex + 1).trim();
				if (
					(value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))
				) {
					value = value.slice(1, -1);
				}
				envVars[key] = value;
			}
		}
		return envVars;
	} catch {
		return {};
	}
}

/**
 * Build the subprocess environment. Layers, in order: backend `.env`, the Claude
 * API/OAuth profile env (so the Claude provider authenticates), then the active
 * provider's credentials from the credential manager (`SELECTED_LLM_PROVIDER` +
 * e.g. WINDSURF_API_KEY / OPENAI_API_KEY), which wins so the runner routes to
 * whatever provider the user selected.
 *
 * `provider` overrides that last layer: an explicit provider gets its own
 * credentials, which is what lets one call run against a provider other than
 * the active one (the Arena runs several at once, on purpose).
 */
async function buildEnv(
	autoBuildSource: string,
	provider?: string,
): Promise<NodeJS.ProcessEnv> {
	const autoBuildEnv = loadAutoBuildEnv(autoBuildSource);
	const apiProfileEnv = await getAPIProfileEnv();
	const isApiProfileActive = Object.keys(apiProfileEnv).length > 0;
	const profileEnv = isApiProfileActive ? {} : getBestAvailableProfileEnv().env;
	const oauthModeClearVars = getOAuthModeClearVars(apiProfileEnv);
	let providerEnv: Record<string, string> = {};
	try {
		providerEnv = credentialManager.getEnvironmentVariables(provider || undefined);
	} catch (error) {
		logger.warn("[OneShotLLM] Could not read provider env:", error);
	}

	return {
		...process.env,
		...autoBuildEnv,
		...profileEnv,
		...apiProfileEnv,
		...oauthModeClearVars,
		...providerEnv,
		PYTHONUNBUFFERED: "1",
		PYTHONIOENCODING: "utf-8",
		PYTHONUTF8: "1",
	};
}

/**
 * Run a single, provider-agnostic LLM text completion via the backend
 * `oneshot_completion_runner.py`. Returns the raw model text, or null on any
 * failure (missing backend, timeout, empty/failed run) so callers degrade
 * gracefully. The prompt is built by the caller; this only handles transport.
 */
export async function runOneShotLLM(
	options: OneShotLLMOptions,
): Promise<string | null> {
	const label = options.debugLabel ?? "OneShotLLM";
	const autoBuildSource = resolveBackendSource(options.autoBuildSourcePath);
	if (!autoBuildSource) {
		logger.warn(`[${label}] Backend source path not found`);
		return null;
	}
	const runnerPath = path.join(autoBuildSource, "runners", ONESHOT_RUNNER);
	if (!existsSync(runnerPath)) {
		logger.warn(`[${label}] One-shot runner not found at ${runnerPath}`);
		return null;
	}

	const payload: Record<string, unknown> = { prompt: options.prompt };
	if (options.onDelta) payload.stream = true;
	if (options.systemPrompt) payload.system_prompt = options.systemPrompt;
	if (options.provider) payload.provider = options.provider;
	if (options.model) payload.model = options.model;
	if (options.requireProvider) payload.require_provider = true;
	if (options.projectDir) payload.project_dir = options.projectDir;
	if (options.specDir) payload.spec_dir = options.specDir;

	let inputFile: string | null = null;
	try {
		const dir = mkdtempSync(path.join(tmpdir(), "wp-oneshot-"));
		inputFile = path.join(dir, "input.json");
		writeFileSync(inputFile, JSON.stringify(payload), "utf-8");
	} catch (error) {
		logger.warn(`[${label}] Could not write runner input:`, error);
		return null;
	}

	const env = await buildEnv(autoBuildSource, options.provider);
	const pythonPath = options.pythonPath ?? getConfiguredPythonPath();
	const cleanup = () => {
		if (inputFile) rmSync(path.dirname(inputFile), { recursive: true, force: true });
	};

	return new Promise((resolve) => {
		const [pythonCommand, pythonBaseArgs] = parsePythonCommand(pythonPath);
		const child = spawn(
			pythonCommand,
			[...pythonBaseArgs, runnerPath, "--input", inputFile as string],
			{ cwd: autoBuildSource, env },
		);

		let output = "";
		let errorOutput = "";
		/** The reason the runner reported, when it reported one. */
		let reportedFailure: string | null = null;
		// Markers arrive line by line, and a read can split a line anywhere —
		// including in the middle of the JSON that carries one. Anything after
		// the last newline is held back until the rest of it shows up.
		let pendingLine = "";

		/** The payload of `marker` on this line, or undefined. */
		const markerPayload = (line: string, marker: string): unknown => {
			const markerIndex = line.indexOf(marker);
			if (markerIndex === -1) return undefined;
			try {
				return JSON.parse(line.slice(markerIndex + marker.length));
			} catch {
				// A line the runner did not write, or one truncated by a kill.
				// The final result is what the caller is graded on; a marker
				// nobody can parse is not worth failing the run over.
				return undefined;
			}
		};

		const consumeMarkers = (chunk: string) => {
			pendingLine += chunk;
			const lines = pendingLine.split("\n");
			pendingLine = lines.pop() ?? "";
			for (const line of lines) {
				if (options.onDelta) {
					const text = markerPayload(line, DELTA_MARKER);
					if (typeof text === "string" && text) options.onDelta(text);
				}
				if (options.onUsage) {
					const usage = markerPayload(line, USAGE_MARKER) as
						| Record<string, unknown>
						| undefined;
					if (usage) {
						const num = (value: unknown) =>
							typeof value === "number" && Number.isFinite(value) ? value : 0;
						options.onUsage({
							inputTokens: num(usage.input_tokens),
							outputTokens: num(usage.output_tokens),
							costUsd: num(usage.cost_usd),
						});
					}
				}
				const detail = markerPayload(line, ERROR_MARKER) as
					| Record<string, unknown>
					| undefined;
				if (detail && typeof detail.message === "string" && detail.message) {
					reportedFailure = detail.message;
				}
			}
		};
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timeout = setTimeout(() => {
			logger.warn(`[${label}] Generation timed out`);
			// Recorded before the kill: the exit handler runs next, and a killed
			// run leaves nothing on stderr to explain itself.
			reportedFailure = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
			child.kill();
		}, timeoutMs);

		child.stdout?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			output += text;
			consumeMarkers(text);
		});
		child.stderr?.on("data", (data: Buffer) => {
			errorOutput += data.toString("utf-8");
		});

		child.on("exit", (code: number | null) => {
			clearTimeout(timeout);
			cleanup();
			const markerIndex = output.indexOf(RESULT_MARKER);
			if (code === 0 && markerIndex !== -1) {
				resolve(output.slice(markerIndex + RESULT_MARKER.length).trim());
				return;
			}

			// Best-effort rate-limit reporting on failure.
			if (options.rateLimitSource && options.onRateLimit) {
				const detection = detectRateLimit(`${output}\n${errorOutput}`);
				if (detection.isRateLimited) {
					options.onRateLimit(
						createSDKRateLimitInfo(options.rateLimitSource, detection),
					);
				}
			}
			logger.warn(`[${label}] Generation failed`, {
				code,
				errorOutput: errorOutput.substring(0, 500),
			});
			// The runner's redacted diagnostic first: stderr can carry a raw
			// provider message, and this reason is meant to be shown.
			options.onFailure?.(
				reportedFailure ||
					errorOutput.trim().split("\n").pop() ||
					`Generation failed (exit ${code ?? "unknown"})`,
			);
			resolve(null);
		});

		child.on("error", (err) => {
			clearTimeout(timeout);
			cleanup();
			logger.warn(`[${label}] Process error:`, err.message);
			options.onFailure?.(err.message);
			resolve(null);
		});
	});
}
