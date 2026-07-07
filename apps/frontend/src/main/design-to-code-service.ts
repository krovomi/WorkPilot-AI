import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { pythonEnvManager } from "./python-env-manager";
import { credentialManager } from "./services/credential-manager";
import { getEffectiveSourcePath } from "./updater/path-resolver";

/**
 * Design-to-Code service — bridges the renderer's "Import Design" panel to the
 * Python `design_to_code_runner.py`. Unlike the streaming VisualProgramming
 * service, the renderer store awaits a single Promise, so this runs
 * request → response: spawn the runner, parse its structured result line, and
 * resolve with the full pipeline result.
 */

export interface DesignToCodeRequest {
	imageData?: string; // data URL (data:image/png;base64,...)
	framework?: string;
	sourceType?: string;
	designSystemPath?: string;
	figmaUrl?: string;
	generateTests?: boolean;
	customInstructions?: string;
}

export interface DesignToCodeResult {
	success: boolean;
	phase: string;
	design_spec: unknown;
	generated_files: {
		path: string;
		content: string;
		language: string;
		description: string;
	}[];
	visual_tests: unknown[];
	design_tokens_used: unknown[];
	figma_sync_status: Record<string, unknown> | null;
	errors: string[];
	warnings: string[];
	duration_seconds: number;
	tokens_used: number;
}

const RESULT_PREFIX = "__DESIGN_TO_CODE_RESULT__:";
const ERROR_PREFIX = "__DESIGN_TO_CODE_ERROR__:";

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
};

export class DesignToCodeService {
	private sourcePath: string | null = null;

	configure(sourcePath?: string): void {
		if (sourcePath) this.sourcePath = sourcePath;
	}

	private getSourcePath(): string | null {
		if (this.sourcePath) return this.sourcePath;
		const resolved = getEffectiveSourcePath();
		if (
			existsSync(path.join(resolved, "runners", "design_to_code_runner.py"))
		) {
			this.sourcePath = resolved;
			return resolved;
		}
		return null;
	}

	private resolvePythonExecutable(): string {
		const managed = pythonEnvManager.getPythonPath();
		if (managed && existsSync(managed)) {
			return managed;
		}
		return "python";
	}

	private buildEnv(sourcePath: string): Record<string, string> {
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
		};
		env.PYTHONPATH = env.PYTHONPATH
			? `${sourcePath}${path.delimiter}${env.PYTHONPATH}`
			: sourcePath;
		// Force UTF-8 stdio so status/result lines aren't mojibaked on Windows
		// (Python defaults to cp1252 there, mangling "…" and accents).
		env.PYTHONIOENCODING = "utf-8";
		env.PYTHONUTF8 = "1";
		env.PYTHONUNBUFFERED = "1";
		try {
			const settingsPath = path.join(app.getPath("userData"), "settings.json");
			if (existsSync(settingsPath)) {
				const { readFileSync } = require("node:fs");
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
				if (settings.globalClaudeOAuthToken)
					env.CLAUDE_OAUTH_TOKEN = settings.globalClaudeOAuthToken;
				if (settings.globalAnthropicApiKey)
					env.ANTHROPIC_API_KEY = settings.globalAnthropicApiKey;
			}
		} catch {
			/* ignore */
		}
		// Provider-agnostic: inject the selected provider + its credentials
		// (SELECTED_LLM_PROVIDER, OPENAI_API_KEY, GOOGLE_API_KEY, …) so vision and
		// code-gen route to whatever LLM the user picked — not just Claude. Wins
		// over the legacy Claude tokens above.
		try {
			Object.assign(env, credentialManager.getEnvironmentVariables());
		} catch {
			/* ignore */
		}
		return env;
	}

	/**
	 * Persist a data URL image to a temp file and return its path. Passing the
	 * raw base64 as an argv string overflows the Windows command line for large
	 * screenshots, so we always go through a file.
	 */
	private writeImageToTemp(dataUrl: string, workDir: string): string {
		const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
		if (!match) {
			throw new Error("Unsupported image data (expected a base64 data URL)");
		}
		const [, mime, base64] = match;
		const ext = MIME_EXTENSIONS[mime] ?? ".png";
		const imagePath = path.join(workDir, `design${ext}`);
		writeFileSync(imagePath, Buffer.from(base64, "base64"));
		return imagePath;
	}

	async run(request: DesignToCodeRequest): Promise<DesignToCodeResult> {
		const sourcePath = this.getSourcePath();
		if (!sourcePath) {
			throw new Error(
				"WorkPilot AI source not found. Cannot locate design_to_code_runner.py",
			);
		}
		if (!request.imageData && !request.figmaUrl) {
			throw new Error("Provide an image or a Figma URL.");
		}

		const runnerPath = path.join(
			sourcePath,
			"runners",
			"design_to_code_runner.py",
		);
		if (!existsSync(runnerPath)) {
			throw new Error("design_to_code_runner.py not found");
		}

		// Scratch directory used both as the runner's project/output dir and to
		// stash the decoded image. Generated files are written here; the renderer
		// only displays their contents, so a temp dir keeps the user's project clean.
		const workDir = mkdtempSync(path.join(tmpdir(), "wp-design2code-"));

		const args = [runnerPath, "--project-dir", workDir, "--output-dir", workDir];

		if (request.imageData) {
			const imagePath = this.writeImageToTemp(request.imageData, workDir);
			args.push("--image-path", imagePath);
		}
		if (request.framework) args.push("--framework", request.framework);
		if (request.sourceType) args.push("--source-type", request.sourceType);
		if (request.designSystemPath)
			args.push("--design-system-path", request.designSystemPath);
		if (request.figmaUrl) args.push("--figma-url", request.figmaUrl);
		if (request.generateTests === false) args.push("--no-tests");
		if (request.customInstructions)
			args.push("--instructions", request.customInstructions);

		const env = this.buildEnv(sourcePath);
		const pythonExe = this.resolvePythonExecutable();

		return await new Promise<DesignToCodeResult>((resolve, reject) => {
			const proc = spawn(pythonExe, args, {
				cwd: sourcePath,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let result: DesignToCodeResult | null = null;
			let markerError: string | null = null;
			let stderrTail = "";
			let stdoutBuffer = "";

			const handleLine = (line: string) => {
				if (line.startsWith(RESULT_PREFIX)) {
					try {
						result = JSON.parse(line.slice(RESULT_PREFIX.length));
					} catch {
						/* ignore malformed result line */
					}
				} else if (line.startsWith(ERROR_PREFIX)) {
					markerError = line.slice(ERROR_PREFIX.length);
				}
			};

			proc.stdout?.on("data", (data: Buffer) => {
				stdoutBuffer += data.toString("utf-8");
				let idx = stdoutBuffer.indexOf("\n");
				while (idx >= 0) {
					handleLine(stdoutBuffer.slice(0, idx).trim());
					stdoutBuffer = stdoutBuffer.slice(idx + 1);
					idx = stdoutBuffer.indexOf("\n");
				}
			});

			proc.stderr?.on("data", (data: Buffer) => {
				stderrTail = (stderrTail + data.toString("utf-8")).slice(-4000);
			});

			proc.on("error", (err) => {
				reject(new Error(`Failed to start design-to-code runner: ${err.message}`));
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
				if (result) {
					resolve(result);
					return;
				}
				if (markerError) {
					reject(new Error(markerError));
					return;
				}
				reject(
					new Error(
						`Design-to-code runner exited with code ${code}. ${stderrTail.slice(-800)}`,
					),
				);
			});
		});
	}
}

export const designToCodeService = new DesignToCodeService();
