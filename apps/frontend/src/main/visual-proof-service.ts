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
import {
	findCommandInPath,
	findMsBuildInvocation,
	LEGACY_MSBUILD_UNAVAILABLE_MESSAGE,
} from "./dotnet-msbuild";
import {
	LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE,
	createLegacyCompilerBuildArgs,
	createLegacyPackageReferencesTarget,
	createLegacySdkBuildArgs,
	ensureLegacyWorktreeBuildAssets,
	LEGACY_RESOURCE_PROPERTY,
	runWithShortLegacySolutionPath,
	runWithLegacyXmlNamespacePatch,
} from "./legacy-dotnet-build";

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
const LEGACY_DOTNET_BUILD_MAX_BUFFER = 100 * 1024 * 1024;
const LEGACY_WEB_HOST_UNAVAILABLE_MESSAGE =
	"IIS Express/xsp was not found for this legacy .NET Framework web app.";

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

interface DesktopCaptureSourceLike {
	id: string;
	name: string;
}

interface DesktopCaptureSelectionOptions {
	excludeSourceIds?: ReadonlySet<string>;
	requireWindowMatch?: boolean;
}

interface DesktopImageCaptureOptions extends DesktopCaptureSelectionOptions {
	preferredNames?: readonly string[];
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

function isLikelyTestProjectPath(candidatePath: string): boolean {
	const segments = candidatePath
		.toLowerCase()
		.split(/[\\/]+/)
		.map((segment) => segment.replace(/\.csproj$/i, ""));
	return segments.some(
		(segment) =>
			segment === "tests" ||
			segment === "test" ||
			segment === "unittests" ||
			segment === "automatedtests" ||
			segment.endsWith(".tests") ||
			segment.endsWith(".test") ||
			segment.endsWith(".testapplication") ||
			segment.includes("testapplication"),
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
			if (
				entry === "node_modules" ||
				entry === ".git" ||
				entry === "dist" ||
				isLikelyTestProjectPath(entry)
			) {
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
	const hasExplicitWebMarkers =
		/System\.Web/i.test(content) ||
		/Microsoft\.WebApplication\.targets/i.test(content) ||
		/{349c5851-65df-11da-9384-00065b846f21}/i.test(content);
	const isWeb = hasExplicitWebMarkers && !isDesktop;

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
		entry.toLowerCase().endsWith(".csproj") && !isLikelyTestProjectPath(entry),
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
	options: DesktopImageCaptureOptions = {},
): Promise<{ width: number; height: number }> {
	const sources = await desktopCapturer.getSources({
		types: options.requireWindowMatch ? ["window"] : ["window", "screen"],
		thumbnailSize: DEFAULT_VIEWPORT,
	});
	if (sources.length === 0) {
		throw new Error("No desktop or window source was available for capture");
	}

	const source = selectDesktopCaptureSource(sources, options.preferredNames, {
		excludeSourceIds: options.excludeSourceIds,
		requireWindowMatch: options.requireWindowMatch,
	});
	if (!source) {
		const names = normalizePreferredWindowNames(options.preferredNames);
		throw new Error(
			names.length > 0
				? `No desktop application window matched ${names.join(", ")}`
				: "No desktop application window was available for capture",
		);
	}
	const size = source.thumbnail.getSize();
	writeFileSync(outputPath, source.thumbnail.toPNG());
	return {
		width: size.width || DEFAULT_VIEWPORT.width,
		height: size.height || DEFAULT_VIEWPORT.height,
	};
}

async function getDesktopWindowSourceIds(): Promise<Set<string>> {
	const sources = await desktopCapturer.getSources({
		types: ["window"],
		thumbnailSize: { width: 1, height: 1 },
	});
	return new Set(sources.map((source) => source.id));
}

function normalizePreferredWindowNames(names: readonly string[] = []): string[] {
	return [
		...new Set(
			names
				.map((name) => name.trim().toLowerCase())
				.filter((name) => name.length > 0),
		),
	];
}

function isWindowSource(source: DesktopCaptureSourceLike): boolean {
	return source.id.startsWith("window:");
}

function isWorkPilotWindowName(name: string): boolean {
	return /workpilot|auto-claude|visual studio code|vscode|copilot/i.test(name);
}

export function selectDesktopCaptureSource<T extends DesktopCaptureSourceLike>(
	sources: readonly T[],
	preferredNames: readonly string[] = [],
	options: DesktopCaptureSelectionOptions = {},
): T | null {
	const preferred = normalizePreferredWindowNames(preferredNames);
	const windows = sources.filter(isWindowSource);
	const eligibleWindows = windows.filter(
		(source) => !isWorkPilotWindowName(source.name),
	);
	const candidateWindows = eligibleWindows.filter(
		(source) => !options.excludeSourceIds?.has(source.id),
	);
	const matchesPreferred = (source: T) => {
		const normalizedSourceName = source.name.toLowerCase();
		return preferred.some((name) => normalizedSourceName.includes(name));
	};

	if (preferred.length > 0) {
		const preferredMatch =
			candidateWindows.find(matchesPreferred) ??
			(options.excludeSourceIds ? undefined : eligibleWindows.find(matchesPreferred));
		if (preferredMatch) {
			return preferredMatch;
		}
	}

	if (candidateWindows[0]) {
		return candidateWindows[0];
	}

	if (options.requireWindowMatch) {
		return null;
	}

	return eligibleWindows[0] ?? windows[0] ?? sources[0] ?? null;
}

async function readWindowsProcessWindowTitle(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowTitle }`,
			],
			{ windowsHide: true, maxBuffer: 64 * 1024 },
		);
		const title = stdout.trim();
		return title.length > 0 ? title : null;
	} catch {
		return null;
	}
}

async function waitForProcessWindowNames(
	child: ChildProcessWithoutNullStreams,
	fallbackNames: readonly string[],
): Promise<string[]> {
	const names = new Set(fallbackNames.filter((name) => name.trim().length > 0));
	if (process.platform !== "win32" || !child.pid) {
		await delay(3000);
		return [...names];
	}

	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const title = await readWindowsProcessWindowTitle(child.pid);
		if (title) {
			names.add(title);
			break;
		}
		await delay(500);
	}
	return [...names];
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

interface LegacyWebHostInvocation {
	command: string;
	args: string[];
	providerDetails: string;
}

function isXspCommand(commandPath: string): boolean {
	const baseName = path.basename(commandPath, path.extname(commandPath)).toLowerCase();
	return baseName === "xsp" || baseName === "xsp4";
}

function createLegacyWebHostInvocation(
	command: string,
	projectDir: string,
	port: number,
): LegacyWebHostInvocation {
	if (isXspCommand(command)) {
		return {
			command,
			args: ["--root", projectDir, "--port", String(port)],
			providerDetails: "Classic ASP.NET app hosted through Mono xsp.",
		};
	}
	return {
		command,
		args: ["/path:" + projectDir, "/port:" + String(port)],
		providerDetails: "Classic ASP.NET app hosted through IIS Express.",
	};
}

function findLegacyWebHostInvocation(
	projectDir: string,
	port: number,
): LegacyWebHostInvocation | null {
	const candidates = [
		process.env[IIS_EXPRESS_ENV],
		"C:\\Program Files\\IIS Express\\iisexpress.exe",
		"C:\\Program Files (x86)\\IIS Express\\iisexpress.exe",
	].filter((candidate): candidate is string => Boolean(candidate));
	const candidate = candidates.find((item) => existsSync(item));
	if (candidate) return createLegacyWebHostInvocation(candidate, projectDir, port);

	const pathIisExpress = findCommandInPath("iisexpress");
	if (pathIisExpress) {
		return createLegacyWebHostInvocation(pathIisExpress, projectDir, port);
	}

	const pathXsp4 = findCommandInPath("xsp4");
	if (pathXsp4) return createLegacyWebHostInvocation(pathXsp4, projectDir, port);

	const pathXsp = findCommandInPath("xsp");
	return pathXsp ? createLegacyWebHostInvocation(pathXsp, projectDir, port) : null;
}

function formatCommandFailure(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return String(error);
	const details = [error.message];
	const withOutput = error as Error & {
		stdout?: string;
		stderr?: string;
		code?: number | string;
	};
	if (withOutput.code !== undefined) {
		details.push(`Exit code: ${withOutput.code}`);
	}
	for (const [label, value] of [
		["stdout", withOutput.stdout],
		["stderr", withOutput.stderr],
	] as const) {
		const trimmed = value?.trim();
		if (trimmed) {
			details.push(`${label}:\n${trimmed.slice(-6000)}`);
		}
	}
	return details.join("\n\n") || fallback;
}

function findContainingSolutionDir(csprojPath: string): string {
	const normalizedCsprojPath = path.normalize(csprojPath).toLowerCase();
	let currentDir = path.dirname(csprojPath);
	for (let depth = 0; depth < 6; depth += 1) {
		let entries: string[];
		try {
			entries = readdirSync(currentDir);
		} catch {
			return `${path.dirname(csprojPath)}${path.sep}`;
		}
		for (const entry of entries.filter((file) => file.endsWith(".sln"))) {
			const content = readTextFile(path.join(currentDir, entry)) ?? "";
			const matches = content.matchAll(
				/Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/gi,
			);
			for (const match of matches) {
				const candidatePath = path
					.resolve(currentDir, match[1])
					.toLowerCase();
				if (path.normalize(candidatePath) === normalizedCsprojPath) {
					return `${currentDir}${path.sep}`;
				}
			}
		}
		const parentDir = path.dirname(currentDir);
		if (!parentDir || parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return `${path.dirname(csprojPath)}${path.sep}`;
}

function isMsBuildNamespaceError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const withOutput = error as Error & { stdout?: string; stderr?: string };
	return [error.message, withOutput.stdout, withOutput.stderr].some((value) =>
		value?.includes("MSB4097"),
	);
}

function isLegacyCompilerTooOldError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const withOutput = error as Error & { stdout?: string; stderr?: string };
	return [error.message, withOutput.stdout, withOutput.stderr].some((value) =>
		/CS1617|Option\s+'.+'\s+non valide pour\s+\/langversion|Invalid option.*\/langversion/i.test(
			value ?? "",
		),
	);
}

async function buildLegacyDotNetProject(csprojPath: string): Promise<void> {
	const msbuild = findMsBuildInvocation({ allowDotnetMsBuild: false });
	if (!msbuild) {
		throw new Error(LEGACY_MSBUILD_UNAVAILABLE_MESSAGE);
	}
	const solutionDir = findContainingSolutionDir(csprojPath);
	ensureLegacyWorktreeBuildAssets(solutionDir, (message) =>
		logger.info(`[VisualProof] ${message}`),
	);
	await runWithShortLegacySolutionPath(
		csprojPath,
		solutionDir,
		async (buildPaths) => {
			const dotnet = findCommandInPath("dotnet");
			if (dotnet) {
				try {
					await execFileAsync(
						dotnet,
						[
							"restore",
							buildPaths.csprojPath,
							`/p:SolutionDir=${buildPaths.solutionDir}`,
						],
						{
							cwd: path.dirname(buildPaths.csprojPath),
							maxBuffer: LEGACY_DOTNET_BUILD_MAX_BUFFER,
						},
					);
				} catch (restoreError) {
					throw new Error(formatCommandFailure(restoreError, "dotnet restore failed"));
				}
			}
			const referencesTarget = createLegacyPackageReferencesTarget(
				buildPaths.csprojPath,
				buildPaths.solutionDir,
			);
			const buildArgs = [
				buildPaths.csprojPath,
				"/t:Build",
				"/nologo",
				"/v:minimal",
				"/clp:ErrorsOnly;Summary",
				"/p:Configuration=Debug",
				`/p:SolutionDir=${buildPaths.solutionDir}`,
				LEGACY_RESOURCE_PROPERTY,
				...createLegacyCompilerBuildArgs(msbuild.command),
				...createLegacySdkBuildArgs(msbuild.command),
				...(referencesTarget
					? [`/p:CustomBeforeMicrosoftCommonTargets=${referencesTarget}`]
					: []),
			];
			const runMsBuild = () =>
				execFileAsync(msbuild.command, [...msbuild.argsPrefix, ...buildArgs], {
					cwd: path.dirname(buildPaths.csprojPath),
					maxBuffer: LEGACY_DOTNET_BUILD_MAX_BUFFER,
				});
			try {
				await runMsBuild();
			} catch (error) {
				if (isMsBuildNamespaceError(error)) {
					try {
						await runWithLegacyXmlNamespacePatch(buildPaths.solutionDir, runMsBuild);
						return;
					} catch (patchedError) {
						if (isLegacyCompilerTooOldError(patchedError)) {
							throw new Error(
								`${LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE}\n\n${formatCommandFailure(
									patchedError,
									"Patched MSBuild failed",
								)}`,
							);
						}
						throw new Error(
							formatCommandFailure(patchedError, "Patched MSBuild failed"),
						);
					}
				}
				if (isLegacyCompilerTooOldError(error)) {
					throw new Error(
						`${LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE}\n\n${formatCommandFailure(
							error,
							"MSBuild failed",
						)}`,
					);
				}
				throw new Error(formatCommandFailure(error, "MSBuild failed"));
			}
		},
		(message) => logger.info(`[VisualProof] ${message}`),
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

interface DesktopRuntimeInvocation {
	command: string;
	args: string[];
	cwd: string;
	providerDetails: string;
}

function findDesktopRuntimeInvocation(
	executablePath: string,
): DesktopRuntimeInvocation | null {
	if (process.platform === "win32") {
		return {
			command: executablePath,
			args: [],
			cwd: path.dirname(executablePath),
			providerDetails: "Visible Windows desktop capture.",
		};
	}

	const mono = findCommandInPath("mono");
	if (mono) {
		return {
			command: mono,
			args: [executablePath],
			cwd: path.dirname(executablePath),
			providerDetails: "Visible desktop capture through Mono.",
		};
	}

	const wine = findCommandInPath("wine");
	if (wine) {
		return {
			command: wine,
			args: [executablePath],
			cwd: path.dirname(executablePath),
			providerDetails: "Visible desktop capture through Wine.",
		};
	}

	return null;
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
				(project) => project.isLegacy && project.isWeb && !project.isDesktop,
			),
		);
	}

	async run(
		context: VisualProofProviderContext,
	): Promise<VisualProofProviderResult> {
		const project = findFirstDotNetProject(
			context.dotnetProjects,
			(candidate) => candidate.isLegacy && candidate.isWeb && !candidate.isDesktop,
		);
		const port = Number(process.env.WORKPILOT_VISUAL_PROOF_PORT) || DEFAULT_IIS_EXPRESS_PORT;
		const host = project
			? findLegacyWebHostInvocation(project.projectDir, port)
			: null;
		if (!project || !host) {
			return {
				status: "skipped",
				targetKind: "web",
				isolated: false,
				providerDetails: `${IIS_EXPRESS_ENV} can override the IIS Express path.`,
				framework: "dotnet-framework",
				screenshots: [],
				error: LEGACY_WEB_HOST_UNAVAILABLE_MESSAGE,
			};
		}

		const appUrl = `http://localhost:${port}/`;
		const child = spawn(host.command, host.args, {
			cwd: project.projectDir,
			windowsHide: true,
		});
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
				providerDetails: host.providerDetails,
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
			(process.platform === "win32" ||
				Boolean(findCommandInPath("mono") ?? findCommandInPath("wine"))) &&
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

		await buildLegacyDotNetProject(project.csprojPath);
		const executablePath = findDesktopExecutable(project.projectDir);
		if (!executablePath) {
			throw new Error(
				"Could not locate a built desktop executable after MSBuild completed.",
			);
		}
		const runtime = findDesktopRuntimeInvocation(executablePath);
		if (!runtime) {
			return {
				status: "skipped",
				targetKind: "desktop",
				isolated: false,
				framework: "dotnet-framework",
				screenshots: [],
				error: "Mono/Wine was not found for this .NET Framework desktop app.",
			};
		}

		mkdirSync(context.artifactDir, { recursive: true });
		const existingWindowIds = await getDesktopWindowSourceIds();
		const child = spawn(runtime.command, runtime.args, {
			cwd: runtime.cwd,
			windowsHide: false,
		});
		try {
			const preferredNames = await waitForProcessWindowNames(child, [
				path.basename(executablePath, ".exe"),
				path.basename(project.projectDir),
			]);
			const fileName = "desktop.png";
			const screenshotPath = path.join(context.artifactDir, fileName);
			const size = await captureDesktopImage(screenshotPath, {
				excludeSourceIds: existingWindowIds,
				preferredNames,
				requireWindowMatch: true,
			});
			return {
				status: "passed",
				targetKind: "desktop",
				isolated: false,
				providerDetails:
					`${runtime.providerDetails} Use Hyper-V or remote-runner for isolation.`,
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

function targetKindForConfig(config: AppEmulatorConfig): VisualProofTargetKind {
	if (config.type === "desktop") return "desktop";
	if (config.isWeb || WEB_FRAMEWORKS.has(config.framework)) return "web";
	return "remote";
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
		targetKind: targetKindForConfig(context.config),
		isolated: false,
		providerDetails: details,
		framework: context.config.framework,
		screenshots: [],
		error:
			`${details} Available provider families: remote-runner, hyper-v, wsl, ` +
			"local-iis-express, local-windows-desktop, docker, local-web.",
	};
}

function createFailedProviderResult(
	context: VisualProofProviderContext,
	providerId: VisualProofProviderId,
	error: unknown,
): VisualProofProviderResult {
	return {
		status: "failed",
		targetKind: targetKindForConfig(context.config),
		isolated: providerId === "docker" || providerId === "wsl" || providerId === "hyper-v",
		providerDetails: `Provider "${providerId}" failed before a screenshot could be captured.`,
		framework: context.config.framework,
		screenshots: [],
		error: error instanceof Error ? error.message : String(error),
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
			const dotnetProjects = config.framework.startsWith("dotnet")
				? analyzeDotNetProjects(config.projectDir ?? runPath)
				: [];
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
				? await provider
						.run(context)
						.catch((error: unknown) =>
							createFailedProviderResult(context, provider.id, error),
						)
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
