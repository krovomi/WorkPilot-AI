import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEmulatorService } from "./app-emulator-service";

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		isPackaged: false,
	},
}));

describe("AppEmulatorService project detection", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "workpilot-emulator-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects a nested legacy ASP.NET project from a worktree root", async () => {
		const appDir = path.join(tempDir, "Sources", "LegacyWeb");
		mkdirSync(appDir, { recursive: true });
		writeFileSync(path.join(appDir, "Web.config"), "<configuration />");
		writeFileSync(
			path.join(appDir, "LegacyWeb.csproj"),
			[
				"<Project>",
				"  <PropertyGroup>",
				"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
				"  </PropertyGroup>",
				"</Project>",
			].join("\n"),
		);

		const config = await new AppEmulatorService().detectProject(tempDir);

		expect(config.framework).toBe("dotnet-framework-iis-express");
		expect(config.isWeb).toBe(true);
		expect(config.projectDir).toBe(appDir);
		expect(config.startCommand).toContain("iisexpress");
		expect(config.startCommand).toContain('/path:"');
	});

	it("classifies a nested legacy WinForms project as a desktop app", async () => {
		const appDir = path.join(tempDir, "src", "HeavyClient");
		mkdirSync(appDir, { recursive: true });
		writeFileSync(
			path.join(appDir, "HeavyClient.csproj"),
			[
				"<Project>",
				"  <PropertyGroup>",
				"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
				"    <OutputType>WinExe</OutputType>",
				"  </PropertyGroup>",
				"</Project>",
			].join("\n"),
		);

		const config = await new AppEmulatorService().detectProject(tempDir);

		expect(config.framework).toBe("dotnet-framework-desktop");
		expect(config.isWeb).toBe(false);
		expect(config.type).toBe("desktop");
		expect(config.projectDir).toBe(appDir);
		expect(config.startCommand).toContain("msbuild");
	});
});
