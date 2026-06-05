import {
	execFile,
	spawn,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { BrowserWindow, desktopCapturer } from "electron";
import { getSpecsDir } from "../shared/constants";
import type {
	VisualProofProviderId,
	VisualProofRun,
	VisualProofRunOptions,
	VisualProofScreenshot,
	VisualProofStatus,
	VisualProofTargetKind,
} from "../shared/types";
import { logger } from "./app-logger";
import type { AppEmulatorConfig } from "./app-emulator-service";
import { appEmulatorService } from "./app-emulator-service";

const execFileAsync = promisify(execFile);
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const DEFAULT_IIS_EXPRESS_PORT = 50548;
const PROVIDER_ENV = "WORKPILOT_VISUAL_PROOF_PROVIDER";
const REMOTE_URL_ENV = "WORKPILOT_VISUAL_PROOF_REMOTE_URL";
const HYPERV_COMMAND_ENV = "WORKPILOT_VISUAL_PROOF_HYPERV_COMMAND";
const HYPERV_ARGS_ENV = "WORKPILOT_VISUAL_PROOF_HYPERV_ARGS";
const WSL_COMMAND_ENV = "WORKPILOT_VISUAL_PROOF_WSL_COMMAND";
const WSL_ARGS_ENV = "WORKPILOT_VISUAL_PROOF_WSL_ARGS";
const IIS_EXPRESS_ENV = "WORKPILOT_IIS_EXPRESS_PATH";
const MSBUILD_ENV = "WORKPILOT_MSBUILD_PATH";

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

interface DotNetProjectInfo {
	csprojPath: string;
	projectDir: string;
	isLegacy: boolean;
	isDesktop: boolean;
	isWeb: boolean;
}

interface VisualProofProviderContext {
	options: VisualProofRunOptions;
	runPath: string;
	artifactDir: string;
	relativeArtifactDir: string;
	config: AppEmulatorConfig;
	dotnetProjects: DotNetProjectInfo[];
}

interface VisualProofProviderResult {
	status: VisualProofStatus;
	targetKind: VisualProofTargetKind;
	isolated: boolean;
	providerDetails?: string;
	framework?: string;
	appUrl?: string;
	screenshots: VisualProofScreenshot[];
	error?: string;
}

interface VisualProofProvider {
	id: VisualProofProviderId;
	canHandle(context: VisualProofProviderContext): boolean;
	run(context: VisualProofProviderContext): Promise<VisualProofProviderResult>;
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

function normalizeEnvProvider(
	value: string | undefined,
): VisualProofProviderId | null {
	if (!value || value === "auto") return null;
	const allowed = new Set<VisualProofProviderId>([
		"local-web",
		"local-iis-express",
		"local-windows-desktop",
		"docker",
		"wsl",
		"hyper-v",
		"remote-runner",
	]);
	return allowed.has(value as VisualProofProviderId)
		? (value as VisualProofProviderId)
		: null;
}

function requestedProvider(
	options: VisualProofRunOptions,
): VisualProofProviderId | null {
	return normalizeEnvProvider(
		options.provider && options.provider !== "auto"
			? options.provider
			: process.env[PROVIDER_ENV],
	);
}

function scanFiles(
	rootDir: string,
	maxDepth: number,
	predicate: (filePath: string, entry: string) => boolean,
): string[] {
	const results: string[] = [];
	const scan = (dir: string, depth: number): void => {
		if (depth < 0) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === "node_modules" || entry === ".git" || entry === "dist") {
				continue;
			}
			const full = path.join(dir, entry);
			let isDirectory = false;
			try {
				isDirectory = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDirectory) {
				scan(full, depth - 1);
				continue;
			}
			if (predicate(full, entry)) {
				results.push(full);
			}
		}
	};
	scan(rootDir, maxDepth);
	return results;
}

function readTextFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function analyzeDotNetProject(csprojPath: string): DotNetProjectInfo {
	const content = readTextFile(csprojPath) ?? "";
	const legacyTfm = /<TargetFrameworkVersion>\s*v4\./i;
	const legacyMoniker = /<TargetFramework[s]?>\s*net4[0-9]{1,2}\b/i;
	const sdkStyle = /<Project\s+Sdk=/i;
	const isLegacy =
		legacyTfm.test(content) ||
		legacyMoniker.test(content) ||
		(!sdkStyle.test(content) && /<TargetFrameworkVersion>/i.test(content));
	const isDesktop =
		/<UseWPF>\s*true\s*<\/UseWPF>/i.test(content) ||
		/<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(content) ||
		/<OutputType>\s*WinExe\s*<\/OutputType>/i.test(content) ||
		/System\.Windows\.Forms/i.test(content) ||
		/PresentationFramework/i.test(content);
	const isWeb =
		/System\.Web/i.test(content) ||
		/Microsoft\.WebApplication\.targets/i.test(content) ||
		/{349c5851-65df-11da-9384-00065b846f21}/i.test(content);

	return {
		csprojPath,
		projectDir: path.dirname(csprojPath),
		isLegacy,
		isDesktop,
		isWeb,
	};
}

export function analyzeDotNetProjects(searchDir: string): DotNetProjectInfo[] {
	return scanFiles(searchDir, 4, (_filePath, entry) =>
		entry.toLowerCase().endsWith(".csproj"),
	).map(analyzeDotNetProject);
}

/**
 * Indicates whether a project targets legacy .NET Framework (for example v4.8).
 *
 * The default emulator uses `dotnet run`, which does not work for non-SDK
 * .NET Framework projects. Provider selection uses this to route legacy web
 * apps to IIS Express and desktop apps to the Windows desktop provider.
 */
export function isLegacyDotNetFramework(searchDir: string): boolean {
	return analyzeDotNetProjects(searchDir).some((project) => project.isLegacy);
}

export function hasLegacyDotNetDesktopProject(searchDir: string): boolean {
	return analyzeDotNetProjects(searchDir).some(
		(project) => project.isLegacy && project.isDesktop,
	);
}

export function hasLegacyDotNetWebProject(searchDir: string): boolean {
	return analyzeDotNetProjects(searchDir).some(
		(project) => project.isLegacy && project.isWeb,
	);
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
		logger.warn("[VisualProof] Could not resolve worktree branch:", error);
		return null;
	}
}

async function commitAndPushArtifacts(
	worktreePath: string,
	relativeDir: string,
	specId: string,
): Promise<string | undefined> {
	await execFileAsync("git", ["add", "--", relativeDir], { cwd: worktreePath });

	const status = await execFileAsync(
		"git",
		["status", "--porcelain", "--", relativeDir],
		{ cwd: worktreePath },
	);
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
		run.provider ? `Provider: \`${run.provider}\`` : undefined,
		run.targetKind ? `Target: \`${run.targetKind}\`` : undefined,
		typeof run.isolated === "boolean"
			? `Isolation: **${run.isolated ? "isolated" : "local"}**`
			: undefined,
		run.providerDetails ? `Provider details: ${run.providerDetails}` : undefined,
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
		await delay(1500);
		const image = await window.webContents.capturePage();
		writeFileSync(outputPath, image.toPNG());
		return DEFAULT_VIEWPORT;
	} finally {
		if (!window.isDestroyed()) {
			window.close();
		}
	}
}

async function captureDesktopImage(
	outputPath: string,
	preferredName?: string,
): Promise<{ width: number; height: number }> {
	const sources = await desktopCapturer.getSources({
		types: ["window", "screen"],
		thumbnailSize: DEFAULT_VIEWPORT,
	});
	if (sources.length === 0) {
		throw new Error("No desktop or window source was available for capture");
	}

	const normalizedName = preferredName?.toLowerCase();
	const source =
		(normalizedName
			? sources.find((candidate) =>
					candidate.name.toLowerCase().includes(normalizedName),
				)
			: undefined) ??
		sources.find((candidate) => candidate.id.startsWith("window:")) ??
		sources[0];
	const size = source.thumbnail.getSize();
	writeFileSync(outputPath, source.thumbnail.toPNG());
	return {
		width: size.width || DEFAULT_VIEWPORT.width,
		height: size.height || DEFAULT_VIEWPORT.height,
	};
}

function waitForProcessWindow(): Promise<void> {
	return delay(3000);
}

async function waitForHttp(url: string, timeoutMs = 30000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.status < 500) return;
		} catch (error) {
			lastError = error;
		}
		await delay(500);
	}
	throw new Error(
		`Timed out waiting for ${url}${lastError ? ` (${String(lastError)})` : ""}`,
	);
}

function parseJsonArrayEnv(envName: string): string[] {
	const raw = process.env[envName];
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
			? parsed
			: [];
	} catch {
		return raw.split(" ").filter(Boolean);
	}
}

function stopChildProcess(child: ChildProcessWithoutNullStreams): void {
	if (!child.killed) {
		child.kill();
	}
}

function findFirstDotNetProject(
	projects: DotNetProjectInfo[],
	predicate: (project: DotNetProjectInfo) => boolean,
): DotNetProjectInfo | undefined {
	return projects.find(predicate);
}

function findIisExpressPath(): string | null {
	const candidates = [
		process.env[IIS_EXPRESS_ENV],
		"C:\\Program Files\\IIS Express\\iisexpress.exe",
		"C:\\Program Files (x86)\\IIS Express\\iisexpress.exe",
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findMsBuildPath(): string | null {
	const candidates = [
		process.env[MSBUILD_ENV],
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function buildLegacyDotNetProject(csprojPath: string): Promise<void> {
	const msbuild = findMsBuildPath();
	if (!msbuild) {
		throw new Error(
			"MSBuild was not found. Set WORKPILOT_MSBUILD_PATH or install Visual Studio Build Tools.",
		);
	}
	await execFileAsync(
		msbuild,
		[csprojPath, "/t:Build", "/p:Configuration=Debug"],
		{
			cwd: path.dirname(csprojPath),
			maxBuffer: 10 * 1024 * 1024,
		},
	);
}

function findDesktopExecutable(projectDir: string): string | null {
	const exeFiles = scanFiles(projectDir, 5, (_filePath, entry) => {
		const lower = entry.toLowerCase();
		return (
			lower.endsWith(".exe") &&
			!lower.includes("vshost") &&
			!lower.includes("testhost") &&
			!lower.includes("iisexpress")
		);
	});
	const ranked = exeFiles.sort((left, right) => {
		const rank = (filePath: string) => {
			const normalized = filePath.toLowerCase();
			if (normalized.includes(`${path.sep}debug${path.sep}`)) return 0;
			if (normalized.includes(`${path.sep}release${path.sep}`)) return 1;
			return 2;
		};
		return rank(left) - rank(right);
	});
	return ranked[0] ?? null;
}

function createScreenshot(
	label: string,
	relativeArtifactDir: string,
	fileName: string,
	absolutePath: string,
	size: { width: number; height: number },
): VisualProofScreenshot {
	return {
		label,
		relativePath: path.join(relativeArtifactDir, fileName),
		absolutePath,
		width: size.width,
		height: size.height,
		capturedAt: new Date().toISOString(),
	};
}

class RemoteRunnerProvider implements VisualProofProvider {
	readonly id = "remote-runner" as const;

	canHandle(): boolean {
		return Boolean(process.env[REMOTE_URL_ENV]);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const endpoint = process.env[REMOTE_URL_ENV];
		if (!endpoint) {
			return {
				status: "skipped",
				targetKind: "remote",
				isolated: true,
				providerDetails: `${REMOTE_URL_ENV} is not configured.`,
				framework: context.config.framework,
				screenshots: [],
				error: "Remote visual proof runner is not configured.",
			};
		}

		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				options: context.options,
				runPath: context.runPath,
				artifactDir: context.artifactDir,
				relativeArtifactDir: context.relativeArtifactDir,
				config: context.config,
				dotnetProjects: context.dotnetProjects,
			}),
		});
		if (!response.ok) {
			throw new Error(`Remote visual proof runner returned HTTP ${response.status}`);
		}
		const payload = (await response.json()) as Partial<VisualProofProviderResult>;
		return {
			status: payload.status ?? "skipped",
			targetKind: payload.targetKind ?? "remote",
			isolated: true,
			providerDetails: payload.providerDetails ?? endpoint,
			framework: payload.framework ?? context.config.framework,
			appUrl: payload.appUrl,
			screenshots: payload.screenshots ?? [],
			error: payload.error,
		};
	}
}

class CommandRunnerProvider implements VisualProofProvider {
	constructor(
		readonly id: VisualProofProviderId,
		private readonly commandEnv: string,
		private readonly argsEnv: string,
		private readonly defaultTargetKind: VisualProofTargetKind,
	) {}

	canHandle(): boolean {
		return Boolean(process.env[this.commandEnv]);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const command = process.env[this.commandEnv];
		if (!command) {
			return {
				status: "skipped",
				targetKind: this.defaultTargetKind,
				isolated: true,
				providerDetails: `${this.commandEnv} is not configured.`,
				framework: context.config.framework,
				screenshots: [],
				error: `${this.id} visual proof provider is not configured.`,
			};
		}
		const input = JSON.stringify({
			options: context.options,
			runPath: context.runPath,
			artifactDir: context.artifactDir,
			relativeArtifactDir: context.relativeArtifactDir,
			config: context.config,
			dotnetProjects: context.dotnetProjects,
		});
		const { stdout } = await execFileAsync(command, parseJsonArrayEnv(this.argsEnv), {
			cwd: context.runPath,
			env: { ...process.env, WORKPILOT_VISUAL_PROOF_INPUT: input },
			maxBuffer: 10 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout || "{}") as Partial<VisualProofProviderResult>;
		return {
			status: parsed.status ?? "skipped",
			targetKind: parsed.targetKind ?? this.defaultTargetKind,
			isolated: true,
			providerDetails: parsed.providerDetails ?? command,
			framework: parsed.framework ?? context.config.framework,
			appUrl: parsed.appUrl,
			screenshots: parsed.screenshots ?? [],
			error: parsed.error,
		};
	}
}

class LocalIisExpressProvider implements VisualProofProvider {
	readonly id = "local-iis-express" as const;

	canHandle(context: VisualProofProviderContext): boolean {
		return Boolean(
			findFirstDotNetProject(
				context.dotnetProjects,
				(project) => project.isLegacy && project.isWeb,
			),
		);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const project = findFirstDotNetProject(
			context.dotnetProjects,
			(candidate) => candidate.isLegacy && candidate.isWeb,
		);
		const iisExpress = findIisExpressPath();
		if (!project || !iisExpress) {
			return {
				status: "skipped",
				targetKind: "web",
				isolated: false,
				providerDetails: `${IIS_EXPRESS_ENV} can override the IIS Express path.`,
				framework: "dotnet-framework",
				screenshots: [],
				error: "IIS Express was not found for this legacy .NET Framework web app.",
			};
		}

		const port = Number(process.env.WORKPILOT_VISUAL_PROOF_PORT) || DEFAULT_IIS_EXPRESS_PORT;
		const appUrl = `http://localhost:${port}/`;
		const child = spawn(
			iisExpress,
			["/path:" + project.projectDir, "/port:" + String(port)],
			{
				cwd: project.projectDir,
				windowsHide: true,
			},
		);
		try {
			await waitForHttp(appUrl);
			mkdirSync(context.artifactDir, { recursive: true });
			const fileName = "home.png";
			const screenshotPath = path.join(context.artifactDir, fileName);
			const viewport = await captureWebPage(appUrl, screenshotPath);
			return {
				status: "passed",
				targetKind: "web",
				isolated: false,
				providerDetails: "Classic ASP.NET app hosted through IIS Express.",
				framework: "dotnet-framework",
				appUrl,
				screenshots: [
					createScreenshot(
						"Home page",
						context.relativeArtifactDir,
						fileName,
						screenshotPath,
						viewport,
					),
				],
			};
		} finally {
			stopChildProcess(child);
		}
	}
}

class LocalWindowsDesktopProvider implements VisualProofProvider {
	readonly id = "local-windows-desktop" as const;

	canHandle(context: VisualProofProviderContext): boolean {
		return (
			process.platform === "win32" &&
			Boolean(
				findFirstDotNetProject(
					context.dotnetProjects,
					(project) => project.isLegacy && project.isDesktop,
				),
			)
		);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const project = findFirstDotNetProject(
			context.dotnetProjects,
			(candidate) => candidate.isLegacy && candidate.isDesktop,
		);
		if (!project) {
			return {
				status: "skipped",
				targetKind: "desktop",
				isolated: false,
				framework: "dotnet-framework",
				screenshots: [],
				error: "No legacy .NET desktop project was detected.",
			};
		}

		let executablePath = findDesktopExecutable(project.projectDir);
		if (!executablePath) {
			await buildLegacyDotNetProject(project.csprojPath);
			executablePath = findDesktopExecutable(project.projectDir);
		}
		if (!executablePath) {
			throw new Error(
				"Could not locate a built desktop executable after MSBuild completed.",
			);
		}

		mkdirSync(context.artifactDir, { recursive: true });
		const child = spawn(executablePath, [], {
			cwd: path.dirname(executablePath),
			windowsHide: false,
		});
		try {
			await waitForProcessWindow();
			const fileName = "desktop.png";
			const screenshotPath = path.join(context.artifactDir, fileName);
			const size = await captureDesktopImage(
				screenshotPath,
				path.basename(executablePath, ".exe"),
			);
			return {
				status: "passed",
				targetKind: "desktop",
				isolated: false,
				providerDetails:
					"Visible Windows desktop capture. Use Hyper-V or remote-runner for isolation.",
				framework: "dotnet-framework",
				screenshots: [
					createScreenshot(
						"Desktop application",
						context.relativeArtifactDir,
						fileName,
						screenshotPath,
						size,
					),
				],
			};
		} finally {
			stopChildProcess(child);
		}
	}
}

class LocalWebProvider implements VisualProofProvider {
	constructor(
		readonly id: VisualProofProviderId,
		private readonly isolated: boolean,
		private readonly predicate: (config: AppEmulatorConfig) => boolean,
	) {}

	canHandle(context: VisualProofProviderContext): boolean {
		return (
			context.config.isWeb &&
			WEB_FRAMEWORKS.has(context.config.framework) &&
			this.predicate(context.config)
		);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		await appEmulatorService.startServer(context.config);
		try {
			const appUrl = appEmulatorService.getUrl();
			if (!appUrl) {
				throw new Error("App emulator did not expose a preview URL");
			}

			mkdirSync(context.artifactDir, { recursive: true });
			const fileName = "home.png";
			const screenshotPath = path.join(context.artifactDir, fileName);
			const viewport = await captureWebPage(appUrl, screenshotPath);
			return {
				status: "passed",
				targetKind: "web",
				isolated: this.isolated,
				providerDetails:
					this.id === "docker"
						? "Docker-backed web preview through the app emulator."
						: "Local web preview through the app emulator.",
				framework: context.config.framework,
				appUrl,
				screenshots: [
					createScreenshot(
						"Home page",
						context.relativeArtifactDir,
						fileName,
						screenshotPath,
						viewport,
					),
				],
			};
		} finally {
			appEmulatorService.stopServer();
		}
	}
}

function buildProviders(): VisualProofProvider[] {
	return [
		new RemoteRunnerProvider(),
		new CommandRunnerProvider("hyper-v", HYPERV_COMMAND_ENV, HYPERV_ARGS_ENV, "remote"),
		new CommandRunnerProvider("wsl", WSL_COMMAND_ENV, WSL_ARGS_ENV, "remote"),
		new LocalIisExpressProvider(),
		new LocalWindowsDesktopProvider(),
		new LocalWebProvider(
			"docker",
			true,
			(config) =>
				config.framework === "docker" || config.framework === "docker-compose",
		),
		new LocalWebProvider(
			"local-web",
			false,
			(config) =>
				config.framework !== "docker" && config.framework !== "docker-compose",
		),
	];
}

function selectProvider(
	context: VisualProofProviderContext,
): VisualProofProvider | undefined {
	const providers = buildProviders();
	const requested = requestedProvider(context.options);
	if (requested) {
		return providers.find((provider) => provider.id === requested);
	}
	return providers.find((provider) => provider.canHandle(context));
}

function createSkippedProviderResult(
	context: VisualProofProviderContext,
	providerId?: VisualProofProviderId,
): VisualProofProviderResult {
	const details = providerId
		? `Provider "${providerId}" was requested but is unavailable or unconfigured.`
		: "No provider can render this task automatically.";
	return {
		status: "skipped",
		targetKind: "remote",
		isolated: false,
		providerDetails: details,
		framework: context.config.framework,
		screenshots: [],
		error:
			`${details} Available provider families: remote-runner, hyper-v, wsl, ` +
			"local-iis-express, local-windows-desktop, docker, local-web.",
	};
}

function attachGitHubUrls(
	screenshots: VisualProofScreenshot[],
	prUrl: string,
	branch: string | null,
): void {
	if (!branch) return;
	const pr = parseGitHubPrUrl(prUrl);
	if (!pr) return;
	for (const screenshot of screenshots) {
		if (screenshot.url) continue;
		screenshot.url =
			`https://github.com/${pr.owner}/${pr.repo}/blob/${branch}/` +
			`${normalizePathForMarkdown(screenshot.relativePath)}?raw=1`;
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
			const dotnetProjects =
				config.framework === "dotnet" ? analyzeDotNetProjects(runPath) : [];
			const context: VisualProofProviderContext = {
				options,
				runPath,
				artifactDir,
				relativeArtifactDir,
				config,
				dotnetProjects,
			};
			const provider = selectProvider(context);
			const providerResult = provider
				? await provider.run(context)
				: createSkippedProviderResult(context, requestedProvider(options) ?? undefined);

			let branch: string | null = null;
			let commitSha: string | undefined;
			if (options.worktreePath && providerResult.screenshots.length > 0) {
				branch = await getCurrentBranch(options.worktreePath);
				commitSha = await commitAndPushArtifacts(
					options.worktreePath,
					relativeArtifactDir,
					options.specId,
				);
				attachGitHubUrls(providerResult.screenshots, options.prUrl, branch);
			}

			const completedRun: VisualProofRun = {
				...runBase,
				status: providerResult.status,
				framework: providerResult.framework ?? config.framework,
				provider: provider?.id ?? requestedProvider(options) ?? undefined,
				targetKind: providerResult.targetKind,
				isolated: providerResult.isolated,
				providerDetails: providerResult.providerDetails,
				appUrl: providerResult.appUrl,
				artifactDir,
				commitSha,
				screenshots: providerResult.screenshots,
				error: providerResult.error,
				completedAt: new Date().toISOString(),
			};

			try {
				const commentUrl = await postGitHubComment(
					options.prUrl,
					buildProofComment(completedRun, branch ?? undefined),
				);
				return { ...completedRun, commentUrl };
			} catch (commentError) {
				logger.warn("[VisualProof] Could not post PR comment:", commentError);
				return completedRun;
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
				logger.warn("[VisualProof] Could not post failure comment:", commentError);
				return failedRun;
			}
		}
	}
}

export const visualProofService = new VisualProofService();
