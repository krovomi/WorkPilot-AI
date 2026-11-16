/**
 * The visual proof of a .NET Framework desktop client on Windows: the client
 * is launched elevated (or not), its window is found by its process, driven by
 * UI Automation and captured with PrintWindow — never the screen. PowerShell
 * is played: each script is answered by what it does, and kept.
 *
 * Whether WorkPilot itself runs elevated is read once per process; this file
 * reads it as "not elevated", and its last test loads the service again to
 * read "elevated".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualProofRunOptions } from "../../shared/types";
import { VisualProofService } from "../visual-proof-service";
import { type Answer, cleanWorld, resetWorld, tempDir, world } from "./visual-proof-world";

vi.mock("node:child_process", async () => (await import("./visual-proof-world")).childProcessModule());
vi.mock("node:timers/promises", async () => (await import("./visual-proof-world")).timersModule());
vi.mock("electron", async () => (await import("./visual-proof-world")).electronModule());
vi.mock("../platform", async () => (await import("./visual-proof-world")).platformModule());
vi.mock("../dotnet-msbuild", async () => (await import("./visual-proof-world")).dotnetMsbuildModule());
vi.mock("../app-emulator-service", async () => (await import("./visual-proof-world")).appEmulatorModule());
vi.mock("../oneshot-llm", async () => (await import("./visual-proof-world")).oneShotModule());

type World = typeof world;

const WINFORMS = `<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><OutputType>WinExe</OutputType><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup>
</Project>`;

const PLAN = {
	desktop: [
		{ label: "Invoices", invoke: "Invoices" },
		{ setText: { name: "Customer", value: "O’Brien" }, label: "Customer" },
	],
};

/** A built WinForms client `Shop.exe`, found by the emulator. */
function client(w: World): { root: string; exe: string } {
	const root = tempDir("vp-win-");
	const projectDir = path.join(root, "Shop");
	mkdirSync(path.join(projectDir, "bin", "Debug"), { recursive: true });
	writeFileSync(path.join(projectDir, "Shop.csproj"), WINFORMS);
	const exe = path.join(projectDir, "bin", "Debug", "Shop.exe");
	writeFileSync(exe, "MZ");
	w.windows = true;
	w.msbuild = { command: "msbuild", argsPrefix: [] };
	w.programs.set("msbuild", () => "Build succeeded.");
	w.emulator.config = {
		type: "desktop",
		framework: "dotnet-framework",
		startCommand: "",
		port: 0,
		isWeb: false,
		projectDir: root,
	};
	return { root, exe };
}

interface Machine {
	elevated?: Answer;
	startProcess?: Answer;
	stopProcess?: Answer;
	/** Answers of `Get-Process … MainWindowTitle`, in turn (the last one stays). */
	titles?: Answer[];
	uiElements?: Answer;
	printWindow?: (script: string) => Answer;
	uiStep?: (script: string) => Answer;
}

/** PowerShell on the machine: each script answered by what it does. */
function powershell(w: World, machine: Machine = {}): string[] {
	const scripts: string[] = [];
	const titles = [...(machine.titles ?? ["Shop - Invoices"])];
	w.programs.set("powershell", (args) => {
		const script = args[args.indexOf("-Command") + 1];
		scripts.push(script);
		if (script.includes("IsInRole")) return machine.elevated ?? "False";
		if (script.includes("Start-Process")) return machine.startProcess ?? "4242\r\n";
		if (script.includes("Stop-Process")) return machine.stopProcess ?? "";
		if (script.includes("MainWindowTitle")) return (titles.length > 1 ? titles.shift() : titles[0]) ?? "";
		if (script.includes("PrintWindow")) return machine.printWindow?.(script) ?? "1280 720 0";
		if (script.includes("ConvertTo-Json")) return machine.uiElements ?? "[]";
		if (script.includes("AutomationElement")) return machine.uiStep?.(script) ?? "";
		return new Error(`unexpected script: ${script.slice(0, 80)}`);
	});
	return scripts;
}

const kind = (script: string): string => {
	if (script.includes("IsInRole")) return "elevation";
	if (script.includes("Start-Process")) return "start";
	if (script.includes("Stop-Process")) return "stop";
	if (script.includes("MainWindowTitle")) return "title";
	if (script.includes("PrintWindow")) return "capture";
	if (script.includes("ConvertTo-Json")) return "ui-elements";
	if (script.includes("InvokePattern")) return "invoke";
	if (script.includes("ValuePattern")) return "set-text";
	return "other";
};

function options(extra: Partial<VisualProofRunOptions> = {}): VisualProofRunOptions {
	return { taskId: "task-1", projectPath: tempDir("vp-project-"), specId: "001-invoices", ...extra };
}

beforeEach(() => {
	resetWorld();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_PROVIDER", "");
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_NAVIGATION", "");
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_DESKTOP_CAPTURES", "");
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_NO_ELEVATE", "");
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await cleanWorld();
});

describe("a desktop client on Windows, WorkPilot not elevated", () => {
	// First run of the file: WorkPilot's own elevation cannot be read, which counts as not elevated.
	it("launches the client elevated, captures its window and says why it cannot drive it", async () => {
		const { root, exe } = client(world);
		const scripts = powershell(world, {
			elevated: new Error("Access denied"),
			titles: ["", "Shop - Invoices"],
			uiElements: JSON.stringify([
				{ name: "Invoices", controlType: "button", automationId: "invoices" },
				{ controlType: "pane" },
			]),
		});
		world.llm = () => JSON.stringify(PLAN);

		const run = await new VisualProofService().run(options({ projectPath: root }));

		expect(run).toMatchObject({
			status: "passed",
			provider: "local-windows-desktop",
			targetKind: "desktop",
		});
		expect(run.providerDetails).toBe(
			"Visible Windows desktop capture. Use Hyper-V or remote-runner for isolation. " +
				"Automated navigation is disabled because the desktop app runs elevated and WorkPilot " +
				"does not (Windows UIPI). Relaunch WorkPilot as administrator to drive the app; " +
				"screenshots are still captured.",
		);
		// UAC launch, window title read, controls listed for the model, no input sent, stopped.
		expect(scripts.map(kind)).toEqual([
			"elevation",
			"start",
			"title",
			"title",
			"ui-elements",
			"capture",
			"capture",
			"stop",
		]);
		const start = scripts[1];
		expect(start).toContain(`Start-Process -FilePath '${exe}' -WorkingDirectory '${path.dirname(exe)}' -Verb RunAs -PassThru;`);
		expect(start).not.toContain("-ArgumentList");
		expect(scripts[2]).toContain("Get-Process -Id 4242");
		expect(scripts.at(-1)).toContain("Stop-Process -Id 4242 -Force");
		expect(world.spawns).toEqual([]);
		// The model saw the controls that exist, and the window's title.
		expect(world.prompts[0]).toContain('"name":"Invoices"');
		expect(world.prompts[0]).not.toContain('"controlType":"pane"');
		expect(world.prompts[0]).toContain("Target window title: Shop");
		// Each capture targets the process's window, written where the run keeps it.
		expect(run.screenshots.map((shot) => [shot.label, shot.width, shot.height])).toEqual([
			["Invoices", 1280, 720],
			["Customer", 1280, 720],
		]);
		for (const [index, shot] of run.screenshots.entries()) {
			const capture = scripts[5 + index];
			expect(capture).toContain("$targetPid = 4242");
			expect(capture).toContain(`'${shot.absolutePath}'`);
			expect(capture).toContain("@('shop','shop - invoices')");
		}
		expect(world.delays).toEqual([500, 1200, 1200]);
	});

	it("drives a client launched without elevation through UI Automation", async () => {
		const { root, exe } = client(world);
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_NO_ELEVATE", "1");
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_NAVIGATION", JSON.stringify(PLAN));
		let captures = 0;
		const scripts = powershell(world, {
			titles: [new Error("Get-Process failed")],
			uiStep: (script) =>
				script.includes("InvokePattern") ? Object.assign(new Error("Command failed"), { code: 3 }) : "",
			printWindow: () => (++captures === 1 ? "0 0 1" : new Error("NO_APP_WINDOW")),
		});

		const run = await new VisualProofService().run(options({ projectPath: root }));

		expect(world.spawns).toHaveLength(1);
		expect(world.spawns[0]).toMatchObject({ cmd: exe, args: [], options: { cwd: path.dirname(exe) } });
		expect(world.spawns[0].proc.killed).toBe(true);
		// The title never came: 10 s of half-second polls, then the file names stand in.
		expect(scripts.filter((script) => kind(script) === "title")).toHaveLength(20);
		const steps = scripts.filter((script) => ["invoke", "set-text"].includes(kind(script)));
		expect(steps).toHaveLength(2);
		expect(steps[0]).toContain("ProcessIdProperty, 7000)");
		expect(steps[0]).toContain("NameProperty, 'Invoices')");
		// The typographic apostrophe is doubled like any other.
		expect(steps[1]).toContain("$value.SetValue('O’’Brien')");
		// A failed step does not stop the walk; an empty frame keeps the default size.
		expect(run.status).toBe("passed");
		expect(run.providerDetails).toBe("Visible Windows desktop capture. Use Hyper-V or remote-runner for isolation.");
		expect(run.screenshots.map((shot) => [shot.label, shot.width, shot.height])).toEqual([
			["Invoices", 1440, 1000],
		]);
		expect(world.prompts).toEqual([]);
	});

	it("fails when the client's window cannot be captured, naming the windows it looked for", async () => {
		const { root } = client(world);
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_DESKTOP_CAPTURES", "2");
		// The controls cannot be listed either: the model plans without them.
		powershell(world, { uiElements: "not json", printWindow: () => new Error("NO_APP_WINDOW") });

		const run = await new VisualProofService().run(options({ projectPath: root }));

		expect(run.status).toBe("failed");
		expect(run.error).toBe("Could not capture the application window (shop, shop - invoices): NO_APP_WINDOW");
	});

	it("waits without a process id, and keeps the run when the client cannot be stopped", async () => {
		const { root } = client(world);
		const scripts = powershell(world, { startProcess: "\r\n", printWindow: () => "garbage" });
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_DESKTOP_CAPTURES", "1");

		const noPid = await new VisualProofService().run(options({ projectPath: root }));

		expect(noPid.status).toBe("passed");
		expect(noPid.screenshots.map((shot) => [shot.width, shot.height])).toEqual([[1440, 1000]]);
		expect(scripts.map(kind)).toEqual(["start", "capture"]);
		expect(scripts[1]).toContain("$targetPid = 0");
		expect(world.delays).toEqual([3000]);

		const stuck = powershell(world, { stopProcess: new Error("Access is denied") });
		const unstoppable = await new VisualProofService().run(options({ projectPath: root }));
		expect(unstoppable.status).toBe("passed");
		expect(stuck.map(kind).at(-1)).toBe("stop");
	});
});

describe("a desktop client on Windows, WorkPilot elevated", () => {
	it("launches the client as a child that UI Automation can drive", async () => {
		// A fresh service reads the elevation again; the mocked machine is the same.
		vi.resetModules();
		const { VisualProofService: FreshService } = await import("../visual-proof-service");
		const { root, exe } = client(world);
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_NAVIGATION", JSON.stringify(PLAN));
		const scripts = powershell(world, { elevated: "True\r\n" });

		const run = await new FreshService().run(options({ projectPath: root }));

		expect(run.status).toBe("passed");
		expect(world.spawns.map((call) => call.cmd)).toEqual([exe]);
		expect(scripts.map(kind)).toEqual(["elevation", "title", "invoke", "capture", "set-text", "capture"]);
		expect(run.providerDetails).toBe("Visible Windows desktop capture. Use Hyper-V or remote-runner for isolation.");
	});
});
