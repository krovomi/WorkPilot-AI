import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDotnet, normalizeRouteTemplate } from "./dotnet";
import type { DetectedRoute, JsonSchema } from "./types";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-dotnet-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

function route(
	routes: DetectedRoute[],
	method: string,
	routePath: string,
): DetectedRoute {
	const found = routes.find(
		(candidate) =>
			candidate.path === routePath && candidate.methods.includes(method),
	);
	if (!found) {
		throw new Error(
			`No ${method} ${routePath} in ${routes
				.map((candidate) => `${candidate.methods[0]} ${candidate.path}`)
				.join(", ")}`,
		);
	}
	return found;
}

const CONTROLLER = `using Microsoft.AspNetCore.Mvc;

namespace Sample.Controllers;

public enum UserStatus { Active, Disabled = 2 }

public record CreateUserRequest(string Email, int Age, UserStatus Status);

public class UserDto
{
    public Guid Id { get; set; }
    /// <summary>Display name.</summary>
    public string Name { get; set; } = string.Empty;
    public List<string> Roles { get; set; } = new();
    public UserDto? Manager { get; set; }
    public static string Ignored { get; set; } = "";
}

public class UserFilter
{
    public string? Term { get; set; }
    public int Page { get; set; }
}

[ApiController]
[Authorize]
[ApiVersion("1.0")]
[Route("api/v{version:apiVersion}/[controller]")]
public class UsersController : ControllerBase
{
    private readonly IUserService _service;

    public UsersController(IUserService service) => _service = service;

    /// <summary>
    /// Gets a user by id.
    /// </summary>
    /// <param name="id">The user identifier.</param>
    [HttpGet("{id:guid}")]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserDto>> GetById(Guid id, CancellationToken cancellationToken)
        => Ok(await _service.GetAsync(id, cancellationToken));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateUserRequest request, IUserService service)
        => Ok();

    [AllowAnonymous]
    [HttpGet("search")]
    public ActionResult<IEnumerable<UserDto>> Search([FromQuery] string? term, int page = 1, [FromHeader(Name = "X-Tenant")] string? tenant = null)
        => Ok();

    [HttpGet("filter")]
    public ActionResult<IEnumerable<UserDto>> Filter(UserFilter filter) => Ok();

    [Obsolete]
    [HttpDelete("{id:guid}")]
    public IActionResult Remove(Guid id) => NoContent();

    [NonAction]
    [HttpGet("hidden")]
    public IActionResult Hidden() => Ok();
}
`;

describe("normalizeRouteTemplate", () => {
	it("drops constraints, defaults and catch-all markers", () => {
		expect(normalizeRouteTemplate("api/items/{id:int}").path).toBe(
			"/api/items/{id}",
		);
		expect(normalizeRouteTemplate("api/{slug?}").path).toBe("/api/{slug}");
		expect(normalizeRouteTemplate("files/{*rest}").path).toBe("/files/{rest}");
		expect(normalizeRouteTemplate("page/{index=1}").path).toBe(
			"/page/{index}",
		);
		expect(normalizeRouteTemplate("re/{id:regex(^a:b$)}").path).toBe(
			"/re/{id}",
		);
	});

	it("reads the parameter type out of the constraint", () => {
		const { parameters } = normalizeRouteTemplate("items/{id:int}/{slug?}");
		expect(parameters).toEqual([
			{ name: "id", schema: { type: "integer", format: "int32" }, required: true },
			{ name: "slug", schema: { type: "string" }, required: false },
		]);
	});
});

describe("detectDotnet — controllers", () => {
	it("resolves route tokens, versions and constraints", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);
		const paths = [...new Set(routes.map((entry) => entry.path))].sort();

		expect(paths).toEqual([
			"/api/v1.0/Users",
			"/api/v1.0/Users/filter",
			"/api/v1.0/Users/search",
			"/api/v1.0/Users/{id}",
		]);
	});

	it("carries XML documentation onto the operation", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);
		const get = route(routes, "GET", "/api/v1.0/Users/{id}");

		expect(get.summary).toBe("Gets a user by id.");
		expect(get.parameters).toEqual([
			{
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string", format: "uuid" },
				description: "The user identifier.",
			},
		]);
	});

	it("inherits [Authorize] from the class and honours [AllowAnonymous]", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);

		expect(route(routes, "GET", "/api/v1.0/Users/{id}").requiresAuth).toBe(true);
		expect(route(routes, "GET", "/api/v1.0/Users/search").requiresAuth).toBe(
			false,
		);
	});

	it("skips [NonAction] members and framework-bound parameters", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);

		expect(routes.some((entry) => entry.path.endsWith("/hidden"))).toBe(false);
		expect(
			route(routes, "GET", "/api/v1.0/Users/{id}").parameters?.map(
				(parameter) => parameter.name,
			),
		).toEqual(["id"]);
	});

	it("binds query, header and body parameters", () => {
		const { routes, schemas } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);

		const search = route(routes, "GET", "/api/v1.0/Users/search");
		expect(search.parameters).toEqual([
			{
				name: "term",
				in: "query",
				required: false,
				schema: { type: "string", nullable: true },
				description: undefined,
			},
			{
				name: "page",
				in: "query",
				required: false,
				schema: { type: "integer", format: "int32" },
				description: undefined,
			},
			{
				name: "X-Tenant",
				in: "header",
				required: false,
				schema: { type: "string", nullable: true },
				description: undefined,
			},
		]);

		const create = route(routes, "POST", "/api/v1.0/Users");
		expect(create.requestBody).toEqual({
			required: true,
			contentType: "application/json",
			schema: { $ref: "#/components/schemas/CreateUserRequest" },
		});
		expect(schemas.CreateUserRequest).toEqual({
			type: "object",
			properties: {
				email: { type: "string" },
				age: { type: "integer", format: "int32" },
				status: { $ref: "#/components/schemas/UserStatus" },
			},
			required: ["email", "age", "status"],
		});
		expect(schemas.UserStatus).toEqual({
			type: "string",
			enum: ["Active", "Disabled"],
		});
	});

	it("leaves injected services out of the request", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);
		const create = route(routes, "POST", "/api/v1.0/Users");

		expect(create.parameters).toEqual([]);
	});

	it("spreads a query-bound model over one parameter per property", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);

		expect(
			route(routes, "GET", "/api/v1.0/Users/filter").parameters?.map(
				(parameter) => [parameter.name, parameter.in],
			),
		).toEqual([
			["term", "query"],
			["page", "query"],
		]);
	});

	it("builds DTO schemas, camel-cased and self-referencing", () => {
		const { schemas } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);
		const user = schemas.UserDto as JsonSchema;

		expect(Object.keys(user.properties ?? {})).toEqual([
			"id",
			"name",
			"roles",
			"manager",
		]);
		expect(user.properties?.name.description).toBe("Display name.");
		expect(user.properties?.roles).toEqual({
			type: "array",
			items: { type: "string" },
		});
		// OpenAPI 3.0 gives `$ref` no siblings, so the nullability of
		// `UserDto?` is dropped rather than emitted next to the reference.
		expect(user.properties?.manager).toEqual({
			$ref: "#/components/schemas/UserDto",
		});
	});

	it("reads [ProducesResponseType] and the return type", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);

		expect(route(routes, "GET", "/api/v1.0/Users/{id}").responses).toEqual({
			"200": {
				description: "Success",
				schema: { $ref: "#/components/schemas/UserDto" },
			},
			"404": { description: "Not Found", schema: undefined },
		});
		expect(route(routes, "GET", "/api/v1.0/Users/search").responses).toEqual({
			"200": {
				description: "Success",
				schema: {
					type: "array",
					items: { $ref: "#/components/schemas/UserDto" },
				},
			},
		});
	});

	it("marks [Obsolete] actions as deprecated", () => {
		const { routes } = detectDotnet(
			createProject({ "Controllers/UsersController.cs": CONTROLLER }),
		);

		expect(route(routes, "DELETE", "/api/v1.0/Users/{id}").deprecated).toBe(
			true,
		);
	});

	it("reads attributes split over several lines", () => {
		const { routes } = detectDotnet(
			createProject({
				"ReportsController.cs": `[Route("api/reports")]
public class ReportsController : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(
        typeof(string),
        StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public IActionResult Get(int id) => Ok();
}`,
			}),
		);

		expect(route(routes, "GET", "/api/reports/{id}").responses).toEqual({
			"200": { description: "Success", schema: { type: "string" } },
			"403": { description: "Forbidden", schema: undefined },
		});
	});

	it("falls back to the controller name when there is no [Route]", () => {
		const { routes } = detectDotnet(
			createProject({
				"HealthController.cs": `public class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok();

    [HttpGet("[action]")]
    public IActionResult Ready() => Ok();
}`,
			}),
		);

		expect(routes.map((entry) => entry.path).sort()).toEqual([
			"/Health",
			"/Health/Ready",
		]);
	});
});

describe("detectDotnet — minimal APIs", () => {
	const PROGRAM = `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

public record Forecast(DateOnly Date, int TemperatureC);

var api = app.MapGroup("/api").RequireAuthorization();
var v1 = api.MapGroup("/v1").WithTags("Weather");

v1.MapGet("/forecast/{days:int}", (int days, [FromQuery] string? city) => Results.Ok())
  .WithSummary("Forecast for the next days")
  .Produces<Forecast>(StatusCodes.Status200OK);

v1.MapPost("/forecast", ([FromBody] Forecast forecast, IForecastService service) => Results.Created())
  .AllowAnonymous();

app.MapMethods("/health", new[] { "GET", "HEAD" }, () => "ok");
`;

	it("resolves nested groups and inherited authorization", () => {
		const { routes } = detectDotnet(
			createProject({ "Program.cs": PROGRAM }),
		);
		const forecast = route(routes, "GET", "/api/v1/forecast/{days}");

		expect(forecast.tag).toBe("Weather");
		expect(forecast.requiresAuth).toBe(true);
		expect(forecast.summary).toBe("Forecast for the next days");
		expect(forecast.parameters).toEqual([
			{
				name: "days",
				in: "path",
				required: true,
				schema: { type: "integer", format: "int32" },
				description: undefined,
			},
			{
				name: "city",
				in: "query",
				required: false,
				schema: { type: "string", nullable: true },
				description: undefined,
			},
		]);
		expect(forecast.responses).toEqual({
			"200": {
				description: "Success",
				schema: { $ref: "#/components/schemas/Forecast" },
			},
		});
	});

	it("honours .AllowAnonymous() and binds the handler body", () => {
		const { routes } = detectDotnet(
			createProject({ "Program.cs": PROGRAM }),
		);
		const create = route(routes, "POST", "/api/v1/forecast");

		expect(create.requiresAuth).toBe(false);
		expect(create.requestBody?.schema).toEqual({
			$ref: "#/components/schemas/Forecast",
		});
		expect(create.parameters).toEqual([]);
	});

	it("expands MapMethods into one route per verb", () => {
		const { routes } = detectDotnet(
			createProject({ "Program.cs": PROGRAM }),
		);

		expect(
			routes
				.filter((entry) => entry.path === "/health")
				.flatMap((entry) => entry.methods)
				.sort(),
		).toEqual(["GET", "HEAD"]);
	});
});
