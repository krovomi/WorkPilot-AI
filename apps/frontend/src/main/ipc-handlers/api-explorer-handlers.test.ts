import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants";
import { registerApiExplorerHandlers } from "./api-explorer-handlers";

const tempProjects: string[] = [];

async function scan(project: string, name: string): Promise<{
	success: boolean;
	data: {
		paths: Record<string, Record<string, Record<string, unknown>>>;
		components?: { schemas?: Record<string, unknown> };
	};
	routeCount: number;
	filesScanned: number;
	frameworks: string[];
	specUrls: string[];
	error?: string;
}> {
	registerApiExplorerHandlers();
	return (await (
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
		name,
	)) as never;
}

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

		const result = await scan(project, "Sample");

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

	it("turns a controller action into a callable operation", async () => {
		const project = mkdtempSync(path.join(tmpdir(), "workpilot-dotnet-"));
		tempProjects.push(project);
		mkdirSync(path.join(project, "Controllers"), { recursive: true });
		writeFileSync(
			path.join(project, "Controllers", "OrdersController.cs"),
			`using Microsoft.AspNetCore.Mvc;

public record CreateOrderRequest(string Reference, decimal Amount);

[ApiController]
[Authorize]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    /// <summary>Creates an order.</summary>
    [HttpPost("{customerId:int}")]
    [ProducesResponseType(StatusCodes.Status201Created)]
    public IActionResult Create(int customerId, [FromBody] CreateOrderRequest request) => Ok();
}`,
		);

		const result = await scan(project, "Shop");
		const operation = result.data.paths["/api/Orders/{customerId}"].post;

		expect(result.success).toBe(true);
		expect(operation.summary).toBe("Creates an order.");
		expect(operation.security).toEqual([{ bearerAuth: [] }]);
		expect(operation.parameters).toEqual([
			{
				name: "customerId",
				in: "path",
				required: true,
				schema: { type: "integer", format: "int32" },
				description: undefined,
			},
		]);
		expect(operation.requestBody).toEqual({
			required: true,
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/CreateOrderRequest" },
				},
			},
		});
		expect(operation.responses).toEqual({ "201": { description: "Created" } });
		expect(result.data.components?.schemas?.CreateOrderRequest).toEqual({
			type: "object",
			properties: {
				reference: { type: "string" },
				amount: { type: "number", format: "double" },
			},
			required: ["reference", "amount"],
		});
	});

	it("reports an unreadable project directory instead of an empty scan", async () => {
		const missing = path.join(tmpdir(), "workpilot-does-not-exist-42");

		const result = await scan(missing, "Ghost");

		expect(result.success).toBe(false);
		expect(result.error).toContain(missing);
	});

	it("reports how many sources it read, so an empty result is legible", async () => {
		const project = mkdtempSync(path.join(tmpdir(), "workpilot-dotnet-"));
		tempProjects.push(project);
		writeFileSync(
			path.join(project, "Helper.cs"),
			"public static class Helper { public static int Add(int a, int b) => a + b; }",
		);

		const result = await scan(project, "NoRoutes");

		expect(result.success).toBe(true);
		expect(result.routeCount).toBe(0);
		expect(result.filesScanned).toBe(1);
	});
});
