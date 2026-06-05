/**
 * Tests unitaires pour les fonctions pures du service de preuve visuelle :
 * parsing d'URL PR GitHub, génération du commentaire markdown et détection
 * des projets .NET Framework legacy.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VisualProofRun } from "../shared/types";
import {
	analyzeDotNetProjects,
	buildProofComment,
	hasLegacyDotNetDesktopProject,
	hasLegacyDotNetWebProject,
	isLegacyDotNetFramework,
	parseGitHubPrUrl,
	selectDesktopCaptureSource,
} from "./visual-proof-service";

describe("parseGitHubPrUrl", () => {
	it("parses a standard GitHub PR URL", () => {
		const ref = parseGitHubPrUrl("https://github.com/acme/widgets/pull/42");
		expect(ref).toEqual({ owner: "acme", repo: "widgets", pullNumber: "42" });
	});

	it("strips a trailing .git from the repo name", () => {
		const ref = parseGitHubPrUrl("https://github.com/acme/widgets.git/pull/7");
		expect(ref?.repo).toBe("widgets");
	});

	it("returns null for a non-PR URL", () => {
		expect(parseGitHubPrUrl("https://github.com/acme/widgets")).toBeNull();
		expect(parseGitHubPrUrl("not a url")).toBeNull();
	});
});

describe("selectDesktopCaptureSource", () => {
	it("prefers the target application window over WorkPilot", () => {
		const source = selectDesktopCaptureSource(
			[
				{ id: "window:1:0", name: "WorkPilot AI" },
				{ id: "window:2:0", name: "EBP Invoicing - Article TVA" },
				{ id: "screen:0:0", name: "Entire Screen" },
			],
			["EBP Invoicing"],
			{ requireWindowMatch: true },
		);

		expect(source?.id).toBe("window:2:0");
	});

	it("uses a newly opened non-WorkPilot window when the title is unknown", () => {
		const source = selectDesktopCaptureSource(
			[
				{ id: "window:1:0", name: "Existing Browser" },
				{ id: "window:2:0", name: "WorkPilot AI" },
				{ id: "window:3:0", name: "Document sans titre" },
			],
			["EBP.Invoicing.Application"],
			{
				excludeSourceIds: new Set(["window:1:0", "window:2:0"]),
				requireWindowMatch: true,
			},
		);

		expect(source?.id).toBe("window:3:0");
	});

	it("ignores pre-existing editor windows even when they match the project name", () => {
		const source = selectDesktopCaptureSource(
			[
				{ id: "window:1:0", name: "EBP.Invoicing.Application - Visual Studio Code" },
				{ id: "window:2:0", name: "WorkPilot AI" },
				{ id: "window:3:0", name: "Limitation TVA" },
			],
			["EBP.Invoicing.Application"],
			{
				excludeSourceIds: new Set(["window:1:0", "window:2:0"]),
				requireWindowMatch: true,
			},
		);

		expect(source?.id).toBe("window:3:0");
	});

	it("does not fall back to WorkPilot when a target window is required", () => {
		const source = selectDesktopCaptureSource(
			[
				{ id: "window:1:0", name: "WorkPilot AI" },
				{ id: "screen:0:0", name: "Entire Screen" },
			],
			["EBP.Invoicing.Application"],
			{ requireWindowMatch: true },
		);

		expect(source).toBeNull();
	});
});

describe("buildProofComment", () => {
	const baseRun: VisualProofRun = {
		id: "visual-proof-1",
		status: "passed",
		taskId: "task-1",
		specId: "spec-1",
		prUrl: "https://github.com/acme/widgets/pull/42",
		framework: "vite",
		appUrl: "http://localhost:5173",
		screenshots: [],
		startedAt: new Date().toISOString(),
	};

	it("renders a markdown image when a screenshot URL is present", () => {
		const comment = buildProofComment({
			...baseRun,
			provider: "local-web",
			targetKind: "web",
			isolated: false,
			screenshots: [
				{
					label: "Home page",
					relativePath: "specs/visual-proofs/spec-1/run/home.png",
					absolutePath: "/abs/home.png",
					url: "https://github.com/acme/widgets/blob/feat/home.png?raw=1",
					width: 1440,
					height: 1000,
					capturedAt: new Date().toISOString(),
				},
			],
		});
		expect(comment).toContain("Status: **passed**");
		expect(comment).toContain("Framework: `vite`");
		expect(comment).toContain("Provider: `local-web`");
		expect(comment).toContain("Target: `web`");
		expect(comment).toContain("Isolation: **local**");
		expect(comment).toContain(
			"![Home page](https://github.com/acme/widgets/blob/feat/home.png?raw=1)",
		);
	});

	it("reports when no screenshot was captured", () => {
		const comment = buildProofComment({ ...baseRun, status: "skipped" });
		expect(comment).toContain("Status: **skipped**");
		expect(comment).toContain("No screenshot was captured.");
	});

	it("includes the error message on failure", () => {
		const comment = buildProofComment({
			...baseRun,
			status: "failed",
			error: "Server did not start",
		});
		expect(comment).toContain("Status: **failed**");
		expect(comment).toContain("Error: Server did not start");
	});
});

describe("isLegacyDotNetFramework", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "vp-dotnet-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects a legacy TargetFrameworkVersion csproj", () => {
		writeFileSync(
			path.join(dir, "App.csproj"),
			"<Project>\n<PropertyGroup>\n<TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n</PropertyGroup>\n</Project>",
		);
		expect(isLegacyDotNetFramework(dir)).toBe(true);
	});

	it("classifies a legacy WinForms client as desktop", () => {
		writeFileSync(
			path.join(dir, "App.csproj"),
			"<Project>\n<PropertyGroup>\n<TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n<OutputType>WinExe</OutputType>\n<UseWindowsForms>true</UseWindowsForms>\n</PropertyGroup>\n</Project>",
		);
		expect(hasLegacyDotNetDesktopProject(dir)).toBe(true);
		expect(hasLegacyDotNetWebProject(dir)).toBe(false);
		const [project] = analyzeDotNetProjects(dir);
		expect(project.isDesktop).toBe(true);
		expect(project.isWeb).toBe(false);
	});

	it("keeps a legacy WinExe desktop app as desktop even when it references System.Web", () => {
		writeFileSync(
			path.join(dir, "App.csproj"),
			"<Project>\n<PropertyGroup>\n<TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n<OutputType>WinExe</OutputType>\n</PropertyGroup>\n<ItemGroup><Reference Include=\"System.Web\" /></ItemGroup>\n</Project>",
		);
		expect(hasLegacyDotNetDesktopProject(dir)).toBe(true);
		expect(hasLegacyDotNetWebProject(dir)).toBe(false);
		const [project] = analyzeDotNetProjects(dir);
		expect(project.isDesktop).toBe(true);
		expect(project.isWeb).toBe(false);
	});

	it("classifies a legacy ASP.NET project as web", () => {
		writeFileSync(
			path.join(dir, "Web.csproj"),
			"<Project>\n<PropertyGroup>\n<TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n</PropertyGroup>\n<ItemGroup><Reference Include=\"System.Web\" /></ItemGroup>\n</Project>",
		);
		expect(hasLegacyDotNetWebProject(dir)).toBe(true);
		expect(hasLegacyDotNetDesktopProject(dir)).toBe(false);
		const [project] = analyzeDotNetProjects(dir);
		expect(project.isWeb).toBe(true);
		expect(project.isDesktop).toBe(false);
	});

	it("detects a legacy net48 moniker csproj", () => {
		writeFileSync(
			path.join(dir, "App.csproj"),
			'<Project Sdk="Microsoft.NET.Sdk">\n<PropertyGroup>\n<TargetFramework>net48</TargetFramework>\n</PropertyGroup>\n</Project>',
		);
		expect(isLegacyDotNetFramework(dir)).toBe(true);
	});

	it("does not flag a modern SDK-style csproj", () => {
		writeFileSync(
			path.join(dir, "App.csproj"),
			'<Project Sdk="Microsoft.NET.Sdk.Web">\n<PropertyGroup>\n<TargetFramework>net10.0</TargetFramework>\n</PropertyGroup>\n</Project>',
		);
		expect(isLegacyDotNetFramework(dir)).toBe(false);
	});

	it("scans nested project directories", () => {
		const nested = path.join(dir, "src", "Web");
		mkdirSync(nested, { recursive: true });
		writeFileSync(
			path.join(nested, "Web.csproj"),
			"<Project>\n<PropertyGroup>\n<TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n</PropertyGroup>\n</Project>",
		);
		expect(isLegacyDotNetFramework(dir)).toBe(true);
	});

	it("returns false when there is no csproj", () => {
		writeFileSync(path.join(dir, "package.json"), "{}");
		expect(isLegacyDotNetFramework(dir)).toBe(false);
	});
});
