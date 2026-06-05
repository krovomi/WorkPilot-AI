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
	buildProofComment,
	isLegacyDotNetFramework,
	parseGitHubPrUrl,
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
