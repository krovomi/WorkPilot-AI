import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BrowserWindow } from "electron";
import { getSpecsDir } from "../shared/constants";
import type {
	VisualProofRun,
	VisualProofRunOptions,
	VisualProofScreenshot,
} from "../shared/types";
import { appEmulatorService } from "./app-emulator-service";
import log from "electron-log/main.js";

const execFileAsync = promisify(execFile);
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const WEB_FRAMEWORKS = new Set([
	"angular",
	"vite",
	"next",
	"nuxt",
	"create-react-app",
	"vue-cli",
	"svelte",
	"django",
	"fastapi",
	"flask",
	"streamlit",
	"dotnet",
	"docker",
	"docker-compose",
	"go",
	"nestjs",
	"express",
]);

interface GitHubPrRef {
	owner: string;
	repo: string;
	pullNumber: string;
}

function createRunId(): string {
	const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	return `visual-proof-${timestamp}`;
}

export function parseGitHubPrUrl(prUrl: string): GitHubPrRef | null {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(
		prUrl,
	);
	if (!match) return null;
	return {
		owner: match[1],
		repo: match[2].replace(/\.git$/i, ""),
		pullNumber: match[3],
	};
}

function normalizePathForMarkdown(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

/**
 * Indique si un projet .NET cible le .NET Framework legacy (ex. v4.8).
 *
 * L'émulateur lance `dotnet run`, qui ne fonctionne pas pour les projets
 * non-SDK (.NET Framework). On détecte ces projets pour produire un résultat
 * "skipped" explicite plutôt qu'un échec cryptique.
 */
export function isLegacyDotNetFramework(searchDir: string): boolean {
	const legacyTfm =
		/<TargetFrameworkVersion>\s*v4\./i;
	const legacyMoniker = /<TargetFramework[s]?>\s*net4[0-9]{1,2}\b/i;
	const sdkStyle = /<Project\s+Sdk=/i;

	const scan = (dir: string, depth: number): boolean => {
		if (depth < 0) return false;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return false;
		}
		for (const entry of entries) {
			if (entry === "node_modules" || entry === ".git") continue;
			const full = path.join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				if (scan(full, depth - 1)) return true;
				continue;
			}
			if (!entry.toLowerCase().endsWith(".csproj")) continue;
			let content: string;
			try {
				content = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			if (legacyTfm.test(content) || legacyMoniker.test(content)) {
				return true;
			}
			if (!sdkStyle.test(content) && /<TargetFrameworkVersion>/i.test(content)) {
				return true;
			}
		}
		return false;
	};

	return scan(searchDir, 3);
}

async function getCurrentBranch(worktreePath: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: worktreePath },
		);
		return stdout.trim() || null;
	} catch (error) {
		log.warn("[VisualProof] Could not resolve worktree branch:", error);
		return null;
	}
}

async function commitAndPushArtifacts(
	worktreePath: string,
	relativeDir: string,
	specId: string,
): Promise<string | undefined> {
	await execFileAsync("git", ["add", "--", relativeDir], { cwd: worktreePath });

	const status = await execFileAsync("git", ["status", "--porcelain", "--", relativeDir], {
		cwd: worktreePath,
	});
	if (!status.stdout.trim()) {
		return undefined;
	}

	await execFileAsync(
		"git",
		["commit", "-m", `Add visual proof screenshots for ${specId}`],
		{ cwd: worktreePath },
	);

	const branch = await getCurrentBranch(worktreePath);
	if (branch) {
		await execFileAsync("git", ["push", "origin", branch], { cwd: worktreePath });
	}

	const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
		cwd: worktreePath,
	});
	return stdout.trim() || undefined;
}

async function postGitHubComment(
	prUrl: string,
	body: string,
): Promise<string | undefined> {
	const pr = parseGitHubPrUrl(prUrl);
	if (!pr) return undefined;

	const { stdout } = await execFileAsync(
		"gh",
		[
			"api",
			`repos/${pr.owner}/${pr.repo}/issues/${pr.pullNumber}/comments`,
			"-f",
			`body=${body}`,
			"--jq",
			".html_url",
		],
		{ encoding: "utf-8" },
	);
	return stdout.trim() || undefined;
}

export function buildProofComment(run: VisualProofRun, branch?: string): string {
	const lines = [
		"## WorkPilot visual proof",
		"",
		`Status: **${run.status}**`,
		run.framework ? `Framework: \`${run.framework}\`` : undefined,
		run.appUrl ? `Emulated URL: ${run.appUrl}` : undefined,
		"",
	].filter((line): line is string => line !== undefined);

	if (run.error) {
		lines.push(`Error: ${run.error}`, "");
	}

	if (run.screenshots.length > 0) {
		lines.push("### Screenshots", "");
		for (const screenshot of run.screenshots) {
			const imageUrl =
				screenshot.url ??
				(branch
					? `blob/${branch}/${normalizePathForMarkdown(
							screenshot.relativePath,
						)}?raw=1`
					: normalizePathForMarkdown(screenshot.relativePath));
			lines.push(`![${screenshot.label}](${imageUrl})`);
			lines.push("");
		}
	} else {
		lines.push("No screenshot was captured.", "");
	}

	lines.push(`Run ID: \`${run.id}\``);
	return lines.join("\n");
}

async function captureWebPage(
	url: string,
	outputPath: string,
): Promise<{ width: number; height: number }> {
	const window = new BrowserWindow({
		show: false,
		width: DEFAULT_VIEWPORT.width,
		height: DEFAULT_VIEWPORT.height,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	try {
		await window.loadURL(url);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const image = await window.webContents.capturePage();
		writeFileSync(outputPath, image.toPNG());
		return DEFAULT_VIEWPORT;
	} finally {
		if (!window.isDestroyed()) {
			window.close();
		}
	}
}

export class VisualProofService {
	async run(options: VisualProofRunOptions): Promise<VisualProofRun> {
		const startedAt = new Date().toISOString();
		const id = createRunId();
		const runBase: VisualProofRun = {
			id,
			status: "pending",
			taskId: options.taskId,
			specId: options.specId,
			prUrl: options.prUrl,
			screenshots: [],
			startedAt,
		};

		const runPath = options.worktreePath ?? options.projectPath;
		const specsBaseDir = getSpecsDir(options.autoBuildPath);
		const relativeArtifactDir = path.join(
			specsBaseDir,
			"visual-proofs",
			options.specId,
			id,
		);
		const artifactDir = path.join(runPath, relativeArtifactDir);

		try {
			const config = await appEmulatorService.detectProject(runPath);
			runBase.framework = config.framework;

			if (
				config.framework === "dotnet" &&
				isLegacyDotNetFramework(config.projectDir ?? runPath)
			) {
				return {
					...runBase,
					status: "skipped",
					artifactDir,
					error:
						'.NET Framework (v4.x) projects are not supported by the automated ' +
						"visual proof adapter, which relies on `dotnet run`. Use IIS Express " +
						"or a manual preview to capture screenshots.",
					completedAt: new Date().toISOString(),
				};
			}

			if (!config.isWeb || !WEB_FRAMEWORKS.has(config.framework)) {
				return {
					...runBase,
					status: "skipped",
					artifactDir,
					error: `Framework "${config.framework}" is not web-renderable by the current visual proof adapter.`,
					completedAt: new Date().toISOString(),
				};
			}

			await appEmulatorService.startServer(config);
			const appUrl = appEmulatorService.getUrl();
			if (!appUrl) {
				throw new Error("App emulator did not expose a preview URL");
			}

			mkdirSync(artifactDir, { recursive: true });
			const screenshotPath = path.join(artifactDir, "home.png");
			const viewport = await captureWebPage(appUrl, screenshotPath);
			const screenshot: VisualProofScreenshot = {
				label: "Home page",
				relativePath: path.join(relativeArtifactDir, "home.png"),
				absolutePath: screenshotPath,
				width: viewport.width,
				height: viewport.height,
				capturedAt: new Date().toISOString(),
			};

			let branch: string | null = null;
			let commitSha: string | undefined;
			if (options.worktreePath) {
				branch = await getCurrentBranch(options.worktreePath);
				commitSha = await commitAndPushArtifacts(
					options.worktreePath,
					relativeArtifactDir,
					options.specId,
				);
				if (branch && parseGitHubPrUrl(options.prUrl)) {
					const pr = parseGitHubPrUrl(options.prUrl);
					if (pr) {
						screenshot.url =
							`https://github.com/${pr.owner}/${pr.repo}/blob/${branch}/` +
							`${normalizePathForMarkdown(screenshot.relativePath)}?raw=1`;
					}
				}
			}

			const passedRun: VisualProofRun = {
				...runBase,
				status: "passed",
				appUrl,
				artifactDir,
				commitSha,
				screenshots: [screenshot],
				completedAt: new Date().toISOString(),
			};

			try {
				const commentUrl = await postGitHubComment(
					options.prUrl,
					buildProofComment(passedRun, branch ?? undefined),
				);
				return { ...passedRun, commentUrl };
			} catch (commentError) {
				log.warn("[VisualProof] Could not post PR comment:", commentError);
				return passedRun;
			}
		} catch (error) {
			const failedRun: VisualProofRun = {
				...runBase,
				status: "failed",
				artifactDir,
				error: error instanceof Error ? error.message : String(error),
				completedAt: new Date().toISOString(),
			};
			try {
				const commentUrl = await postGitHubComment(
					options.prUrl,
					buildProofComment(failedRun),
				);
				return { ...failedRun, commentUrl };
			} catch (commentError) {
				log.warn("[VisualProof] Could not post failure comment:", commentError);
				return failedRun;
			}
		} finally {
			appEmulatorService.stopServer();
		}
	}
}

export const visualProofService = new VisualProofService();
