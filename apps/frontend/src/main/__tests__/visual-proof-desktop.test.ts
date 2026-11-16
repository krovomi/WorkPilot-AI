/**
 * The visual proof of a .NET Framework application off Windows: MSBuild builds
 * it, Mono or Wine launches the desktop client and Electron captures its own
 * window; a classic ASP.NET site is hosted by IIS Express or xsp and captured
 * like any web app. The solution is real folders, the site a real HTTP server;
 * MSBuild, dotnet, Mono and the window list are played.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualProofRunOptions } from "../../shared/types";
import { LEGACY_MSBUILD_UNAVAILABLE_MESSAGE } from "../dotnet-msbuild";
import {
	LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE,
	LEGACY_RESOURCE_PROPERTY,
} from "../legacy-dotnet-build";
import { VisualProofService } from "../visual-proof-service";
import {
	type ExecCall,
	appServer,
	cleanWorld,
	closedPort,
	resetWorld,
	tempDir,
	world,
} from "./visual-proof-world";

vi.mock("node:child_process", async () => (await import("./visual-proof-world")).childProcessModule());
vi.mock("node:fs", async () => (await import("./visual-proof-world")).fsModule());
vi.mock("node:timers/promises", async () => (await import("./visual-proof-world")).timersModule());
vi.mock("electron", async () => (await import("./visual-proof-world")).electronModule());
vi.mock("../platform", async () => (await import("./visual-proof-world")).platformModule());
vi.mock("../dotnet-msbuild", async () => (await import("./visual-proof-world")).dotnetMsbuildModule());
vi.mock("../app-emulator-service", async () => (await import("./visual-proof-world")).appEmulatorModule());
vi.mock("../oneshot-llm", async () => (await import("./visual-proof-world")).oneShotModule());

const WINFORMS = `<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><OutputType>WinExe</OutputType><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup>
  <ItemGroup><Reference Include="System.Windows.Forms" /><Compile Include="Main.cs" xmlns="" /></ItemGroup>
</Project>`;

const WEBFORMS = `<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><OutputType>Library</OutputType><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup>
  <ItemGroup><Reference Include="System.Web" /></ItemGroup>
</Project>`;

const HOME = "<!doctype html><html><body><h1>Shop</h1></body></html>";

interface Solution {
	root: string;
	projectDir: string;
	csproj: string;
	exe: string;
}

/**
 * `Shop.sln` declaring `src\Shop\Shop.csproj` (Windows separators, as a .sln
 * always has them); `built` leaves the output MSBuild would have written.
 */
function solution({ csproj = WINFORMS, sln = true, built = true, root = tempDir("vp-sln-") } = {}): Solution {
	const projectDir = path.join(root, "src", "Shop");
	mkdirSync(projectDir, { recursive: true });
	const csprojPath = path.join(projectDir, "Shop.csproj");
	writeFileSync(csprojPath, csproj);
	if (sln) {
		writeFileSync(
			path.join(root, "Shop.sln"),
			'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Other", "src\\Other\\Other.csproj", "{1}"\n' +
				'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop", "src\\Shop\\Shop.csproj", "{2}"\n',
		);
	}
	const exe = path.join(projectDir, "bin", "Debug", "Shop.exe");
	if (built) {
		for (const dir of ["Debug", "Release"]) {
			mkdirSync(path.join(projectDir, "bin", dir), { recursive: true });
			writeFileSync(path.join(projectDir, "bin", dir, "Shop.exe"), "MZ");
		}
		writeFileSync(path.join(projectDir, "bin", "Debug", "Shop.vshost.exe"), "MZ");
	}
	world.emulator.config = {
		type: csproj === WEBFORMS ? "web" : "desktop",
		framework: "dotnet-framework",
		startCommand: "",
		port: 0,
		isWeb: false,
		projectDir: root,
	};
	return { root, projectDir, csproj: csprojPath, exe };
}

/** MSBuild found on the machine; each build is kept with the project file it saw. */
function msbuild(answer: (args: string[]) => string | Error = () => "Build succeeded."): {
	builds: { args: string[]; options: ExecCall["options"]; csproj: string }[];
} {
	const builds: { args: string[]; options: ExecCall["options"]; csproj: string }[] = [];
	world.msbuild = { command: "msbuild", argsPrefix: ["/m"] };
	world.programs.set("msbuild", (args, options) => {
		builds.push({ args, options, csproj: readFileSync(args[1], "utf-8") });
		return answer(args);
	});
	return { builds };
}

/** Launching the app opens its window beside those already on screen. */
function windowOpensOnLaunch(): void {
	world.sources = [
		{ id: "window:1", name: "Shop notes.txt" },
		{ id: "window:2", name: "WorkPilot" },
		{ id: "screen:0", name: "Entire screen" },
	];
	world.onSpawn = () => {
		world.sources.push({ id: "window:42", name: "Shop - Invoices", width: 1024, height: 768 });
	};
}

function options(extra: Partial<VisualProofRunOptions> = {}): VisualProofRunOptions {
	return { taskId: "task-1", projectPath: tempDir("vp-project-"), specId: "001-invoices", ...extra };
}

beforeEach(() => {
	resetWorld();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_PROVIDER", "");
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_NAVIGATION", "");
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_DESKTOP_CAPTURES", "");
	vi.stubEnv("WORKPILOT_IIS_EXPRESS_PATH", "");
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_PORT", "");
	vi.stubEnv("WORKPILOT_CSC_TOOL_PATH", "");
	vi.stubEnv("WORKPILOT_SDK_TOOLS_PATH", "");
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await cleanWorld();
});

describe("a .NET Framework desktop client through Mono", () => {
	it("builds it, launches its debug build and captures only its window", async () => {
		const sln = solution();
		const { builds } = msbuild();
		world.onPath.set("mono", "/usr/bin/mono");
		world.onPath.set("dotnet", "/usr/bin/dotnet");
		world.programs.set("/usr/bin/dotnet", () => "Restored.");
		windowOpensOnLaunch();

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run).toMatchObject({
			status: "passed",
			provider: "local-windows-desktop",
			targetKind: "desktop",
			isolated: false,
			framework: "dotnet-framework",
			providerDetails:
				"Visible desktop capture through Mono. Use Hyper-V or remote-runner for isolation.",
		});
		// The packages are restored, then the project is built against its solution.
		const restore = world.execs.find((call) => call.cmd === "/usr/bin/dotnet");
		expect(restore?.args).toEqual(["restore", sln.csproj, `/p:SolutionDir=${sln.root}${path.sep}`]);
		expect(restore?.options.cwd).toBe(sln.projectDir);
		expect(builds).toHaveLength(1);
		expect(builds[0].args).toEqual([
			"/m",
			sln.csproj,
			"/t:Build",
			"/nologo",
			"/v:minimal",
			"/clp:ErrorsOnly;Summary",
			"/p:Configuration=Debug",
			`/p:SolutionDir=${sln.root}${path.sep}`,
			LEGACY_RESOURCE_PROPERTY,
		]);
		// MSBuild never sees the empty namespaces that break it; the file is put back.
		expect(builds[0].csproj).not.toContain('xmlns=""');
		expect(readFileSync(sln.csproj, "utf-8")).toBe(WINFORMS);
		// The debug build is launched (not the Release one, not the vshost).
		expect(world.spawns).toHaveLength(1);
		expect(world.spawns[0]).toMatchObject({
			cmd: "/usr/bin/mono",
			args: [sln.exe],
			options: { cwd: path.dirname(sln.exe) },
		});
		expect(world.spawns[0].proc.killed).toBe(true);
		// Three captures of the app window, spaced so the app can load.
		expect(run.screenshots.map((shot) => shot.label)).toEqual([
			"Desktop application (1/3)",
			"Desktop application (2/3)",
			"Desktop application (3/3)",
		]);
		for (const [index, shot] of run.screenshots.entries()) {
			expect(path.basename(shot.absolutePath)).toBe(`desktop-${index + 1}.png`);
			expect(readFileSync(shot.absolutePath, "utf-8")).toBe("PNG Shop - Invoices");
			expect(shot).toMatchObject({ width: 1024, height: 768 });
		}
		expect(world.delays).toEqual([3000, 2500, 2500]);
		// No plan was written and no model is reachable: the model was asked once.
		expect(world.prompts).toHaveLength(1);
		expect(world.prompts[0]).toContain("Target: desktop");
		expect(world.prompts[0]).toContain("Target window title: Shop");
	});

	it("walks to the feature with a generated plan and captures each step", async () => {
		const sln = solution({ sln: false });
		msbuild();
		world.onPath.set("mono", "/usr/bin/mono");
		windowOpensOnLaunch();
		world.llm = () =>
			JSON.stringify({
				desktop: [
					{ label: "Invoices", invoke: "Invoices" },
					{ setText: { name: "Search", value: "acme" }, capture: false, delayMs: 300 },
					{ label: "Filtered list", invoke: "Filter" },
				],
			});

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.status).toBe("passed");
		expect(run.screenshots.map((shot) => [shot.label, path.basename(shot.absolutePath)])).toEqual([
			["Invoices", "feature-1-invoices.png"],
			["Filtered list", "feature-2-filtered-list.png"],
		]);
		expect(world.delays).toEqual([3000, 1200, 300, 1200]);
		// Off Windows there is no UI Automation: no PowerShell ran at all.
		expect(world.execs.filter((call) => call.cmd === "powershell")).toEqual([]);
		const generated = JSON.parse(
			readFileSync(path.join(run.artifactDir ?? "", "navigation.generated.json"), "utf-8"),
		);
		expect(generated.desktop).toHaveLength(3);
		// Without a solution the project folder is the solution folder.
		const build = world.execs.find((call) => call.cmd === "msbuild");
		expect(build?.args).toContain(`/p:SolutionDir=${sln.projectDir}${path.sep}`);
	});

	it("captures the app anyway when no step of the plan captures", async () => {
		const sln = solution();
		msbuild();
		world.onPath.set("mono", "/usr/bin/mono");
		windowOpensOnLaunch();
		vi.stubEnv(
			"WORKPILOT_VISUAL_PROOF_NAVIGATION",
			JSON.stringify({ desktop: [{ invoke: "Invoices", capture: false }] }),
		);
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_DESKTOP_CAPTURES", "1");

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.screenshots.map((shot) => [shot.label, path.basename(shot.absolutePath)])).toEqual([
			["Desktop application", "desktop.png"],
		]);
		expect(world.prompts).toEqual([]);
	});

	it("fails rather than capture another window when the app shows none", async () => {
		const sln = solution();
		msbuild();
		world.onPath.set("mono", "/usr/bin/mono");
		world.sources = [{ id: "window:2", name: "WorkPilot" }];

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run).toMatchObject({
			status: "failed",
			provider: "local-windows-desktop",
			error: "No desktop application window matched shop",
			providerDetails: 'Provider "local-windows-desktop" failed before a screenshot could be captured.',
		});
		expect(world.spawns[0].proc.killed).toBe(true);
	});

	it("fails on a plan whose steps find no window, and when nothing can be captured", async () => {
		const sln = solution();
		msbuild();
		world.onPath.set("mono", "/usr/bin/mono");
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_NAVIGATION", JSON.stringify({ desktop: [{ label: "Invoices" }] }));

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.status).toBe("failed");
		expect(run.error).toBe("No window source was available for capture");
	});
});

describe("building a .NET Framework client", () => {
	it("lends a task worktree the packages of the main copy before building", async () => {
		const repo = tempDir("vp-repo-");
		mkdirSync(path.join(repo, "app", "packages", "Newtonsoft.Json.13.0.3"), { recursive: true });
		const root = path.join(repo, ".workpilot", "worktrees", "tasks", "001-invoices", "app");
		mkdirSync(root, { recursive: true });
		const sln = solution({ root });
		const { builds } = msbuild();
		world.onPath.set("mono", "/usr/bin/mono");
		windowOpensOnLaunch();

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.status).toBe("passed");
		expect(builds).toHaveLength(1);
		const linked = path.join(root, "packages");
		expect(lstatSync(linked).isSymbolicLink()).toBe(true);
		expect(realpathSync(linked)).toBe(realpathSync(path.join(repo, "app", "packages")));
	});

	it("runs a desktop client through Wine when Mono is missing, without a model to plan", async () => {
		const sln = solution();
		msbuild();
		world.onPath.set("wine", "/usr/bin/wine");
		windowOpensOnLaunch();
		world.llm = () => {
			throw new Error("model unavailable");
		};

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.providerDetails).toBe(
			"Visible desktop capture through Wine. Use Hyper-V or remote-runner for isolation.",
		);
		expect(world.spawns[0]).toMatchObject({ cmd: "/usr/bin/wine", args: [sln.exe] });
	});

	it("builds, then skips a client nothing here can run", async () => {
		const sln = solution();
		const { builds } = msbuild();

		const run = await new VisualProofService().run(
			options({ projectPath: sln.root, provider: "local-windows-desktop" }),
		);

		expect(builds).toHaveLength(1);
		expect(run).toMatchObject({
			status: "skipped",
			provider: "local-windows-desktop",
			error: "Mono/Wine was not found for this .NET Framework desktop app.",
		});
		expect(world.spawns).toEqual([]);
	});

	it("skips the desktop provider when the solution has no desktop client", async () => {
		const sln = solution({ csproj: WEBFORMS });

		const run = await new VisualProofService().run(
			options({ projectPath: sln.root, provider: "local-windows-desktop" }),
		);

		expect(run).toMatchObject({ status: "skipped", error: "No legacy .NET desktop project was detected." });
	});

	it("fails when no MSBuild is installed, or when the build leaves no executable", async () => {
		const sln = solution({ built: false });
		world.onPath.set("mono", "/usr/bin/mono");

		const noMsBuild = await new VisualProofService().run(options({ projectPath: sln.root }));
		expect(noMsBuild).toMatchObject({ status: "failed", error: LEGACY_MSBUILD_UNAVAILABLE_MESSAGE });

		msbuild();
		const noExe = await new VisualProofService().run(options({ projectPath: sln.root }));
		expect(noExe).toMatchObject({
			status: "failed",
			error: "Could not locate a built desktop executable after MSBuild completed.",
		});
		expect(world.spawns).toEqual([]);
	});

	it("names the compiler to install when the one found is too old", async () => {
		const sln = solution();
		world.onPath.set("mono", "/usr/bin/mono");
		msbuild(() =>
			Object.assign(new Error("Command failed: msbuild"), {
				code: 1,
				stdout: "Main.cs(3): error CS1617: Invalid option '7.3' for /langversion",
				stderr: "",
			}),
		);

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.status).toBe("failed");
		expect(run.error).toBe(
			`${LEGACY_COMPATIBLE_MSBUILD_REQUIRED_MESSAGE}\n\nCommand failed: msbuild\n\nExit code: 1\n\n` +
				"stdout:\nMain.cs(3): error CS1617: Invalid option '7.3' for /langversion",
		);
		// The project file is put back even when the build fails.
		expect(readFileSync(sln.csproj, "utf-8")).toBe(WINFORMS);
	});

	it("reports what MSBuild or the restore printed", async () => {
		const sln = solution();
		world.onPath.set("mono", "/usr/bin/mono");
		msbuild(() =>
			Object.assign(new Error("Command failed: msbuild"), {
				stderr: "error MSB3644: The reference assemblies for .NETFramework,Version=v4.8 were not found.",
			}),
		);

		const build = await new VisualProofService().run(options({ projectPath: sln.root }));
		expect(build.error).toBe(
			"Command failed: msbuild\n\nstderr:\nerror MSB3644: The reference assemblies for .NETFramework,Version=v4.8 were not found.",
		);

		world.onPath.set("dotnet", "/usr/bin/dotnet");
		world.programs.set("/usr/bin/dotnet", () => new Error("Unable to load the service index for source"));
		const restore = await new VisualProofService().run(options({ projectPath: sln.root }));
		expect(restore.error).toBe("Unable to load the service index for source");
		expect(world.execs.filter((call) => call.cmd === "msbuild")).toHaveLength(1);
	});
});

describe("a classic ASP.NET site", () => {
	// The Windows CI machines have Visual Studio, hence IIS Express where it installs itself.
	beforeEach(() => {
		world.absent.add("C:\\Program Files\\IIS Express\\iisexpress.exe");
		world.absent.add("C:\\Program Files (x86)\\IIS Express\\iisexpress.exe");
	});

	async function site(port?: number): Promise<{ sln: Solution; port: number }> {
		const sln = solution({ csproj: WEBFORMS });
		const url = port === undefined ? await appServer({ "/": HOME }) : `http://127.0.0.1:${port}/`;
		const actual = Number(new URL(url).port);
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_PORT", String(actual));
		return { sln, port: actual };
	}

	it("hosts it in the IIS Express named in the settings and captures it", async () => {
		const { sln, port } = await site();
		const iisExpress = path.join(tempDir("vp-iis-"), "iisexpress.exe");
		writeFileSync(iisExpress, "MZ");
		vi.stubEnv("WORKPILOT_IIS_EXPRESS_PATH", iisExpress);

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run).toMatchObject({
			status: "passed",
			provider: "local-iis-express",
			targetKind: "web",
			framework: "dotnet-framework",
			appUrl: `http://localhost:${port}/`,
			providerDetails: "Classic ASP.NET app hosted through IIS Express.",
		});
		expect(world.spawns[0]).toMatchObject({
			cmd: iisExpress,
			args: [`/path:${sln.projectDir}`, `/port:${port}`],
			options: { cwd: sln.projectDir },
		});
		expect(world.spawns[0].proc.killed).toBe(true);
		expect(run.screenshots.map((shot) => shot.label)).toEqual(["Home page"]);
		expect(readFileSync(run.screenshots[0].absolutePath, "utf-8")).toBe(`PNG http://localhost:${port}/`);
	});

	it.each([
		["iisexpress", "/opt/iis/iisexpress", "IIS Express", (dir: string, port: number) => [`/path:${dir}`, `/port:${port}`]],
		["xsp4", "/usr/bin/xsp4", "Mono xsp", (dir: string, port: number) => ["--root", dir, "--port", String(port)]],
		["xsp", "/usr/bin/xsp", "Mono xsp", (dir: string, port: number) => ["--root", dir, "--port", String(port)]],
	])("hosts it with %s found on the PATH", async (name, found, host, args) => {
		const { sln, port } = await site();
		world.onPath.set(name, found);

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.status).toBe("passed");
		expect(run.providerDetails).toBe(`Classic ASP.NET app hosted through ${host}.`);
		expect(world.spawns[0]).toMatchObject({ cmd: found, args: args(sln.projectDir, port) });
	});

	it("skips the site when no web host is installed", async () => {
		const { sln } = await site();

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run).toMatchObject({
			status: "skipped",
			provider: "local-iis-express",
			providerDetails: "WORKPILOT_IIS_EXPRESS_PATH can override the IIS Express path.",
		});
		expect(run.error).toContain("IIS Express");
		expect(world.spawns).toEqual([]);
	});

	it("gives up on a site that never answers, and stops its host", async () => {
		const { sln, port } = await site(await closedPort());
		world.onPath.set("xsp4", "/usr/bin/xsp4");

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.status).toBe("failed");
		expect(run.error).toMatch(new RegExp(`^Timed out waiting for http://localhost:${port}/ \\(TypeError: fetch failed\\)$`));
		expect(world.delays.length).toBe(60);
		expect(world.spawns[0].proc.killed).toBe(true);
	});

	it("keeps waiting while the site answers with a server error", async () => {
		const sln = solution({ csproj: WEBFORMS });
		const url = await appServer({ "/": { status: 503, body: "starting" } });
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_PORT", new URL(url).port);
		world.onPath.set("xsp4", "/usr/bin/xsp4");

		const run = await new VisualProofService().run(options({ projectPath: sln.root }));

		expect(run.error).toBe(`Timed out waiting for http://localhost:${new URL(url).port}/`);
	});
});
