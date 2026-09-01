import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants";
import { registerApiExplorerHandlers } from "./api-explorer-handlers";

const tempProjects: string[] = [];

afterEach(() => {
	for (const project of tempProjects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

describe("API Explorer project discovery", () => {
	it("discovers ASP.NET Minimal API routes and launch profile specs", async () => {
		const project = mkdtempSync(path.join(tmpdir(), "workpilot-dotnet-"));
		tempProjects.push(project);
		writeFileSync(
			path.join(project, "Sample.csproj"),
			'<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
		);
		writeFileSync(
			path.join(project, "Program.cs"),
			`var app = builder.Build();
const api = app.MapGroup("/api");
api.MapGet("/weather/{id}", (string id) => id);
api.MapPost("/weather", () => Results.Ok());
app.MapGet("/health", () => "ok");`,
		);
		const properties = path.join(project, "Properties");
		mkdirSync(properties);
		writeFileSync(
			path.join(properties, "launchSettings.json"),
			JSON.stringify({
				profiles: {
					http: { applicationUrl: "http://localhost:5180" },
				},
			}),
		);

		registerApiExplorerHandlers();
		const result = (await (
			ipcMain as typeof ipcMain & {
				invokeHandler: (
					channel: string,
					event: unknown,
					...args: unknown[]
				) => Promise<unknown>;
			}
		).invokeHandler(
			IPC_CHANNELS.API_EXPLORER_SCAN_ROUTES,
			null,
			project,
			"Sample",
		)) as {
			success: boolean;
			data: { paths: Record<string, unknown> };
			frameworks: string[];
			specUrls: string[];
		};

		expect(Object.keys(result.data.paths).sort()).toEqual([
			"/api/weather",
			"/api/weather/{id}",
			"/health",
		]);
		expect(result.frameworks).toContain("ASP.NET Core");
		expect(result.specUrls).toContain(
			"http://localhost:5180/swagger/v1/swagger.json",
		);
	});
});
