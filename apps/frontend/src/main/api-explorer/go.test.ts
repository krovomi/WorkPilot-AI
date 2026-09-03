import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectGo, toOpenApiPath } from "./go";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-go-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

const routesOf = (project: string) =>
	detectGo(project)
		.map((route) => `${route.methods[0]} ${route.path}`)
		.sort();

describe("toOpenApiPath", () => {
	it("rewrites Gin parameter syntax and leaves Chi's alone", () => {
		expect(toOpenApiPath("/users/:id")).toBe("/users/{id}");
		expect(toOpenApiPath("/files/*filepath")).toBe("/files/{filepath}");
		expect(toOpenApiPath("/users/{id}")).toBe("/users/{id}");
	});
});

describe("detectGo", () => {
	it("follows nested groups", () => {
		const project = createProject({
			"main.go": `package main

func main() {
	r := gin.Default()
	api := r.Group("/api")
	v1 := api.Group("/v1")

	v1.GET("/users", listUsers)
	v1.GET("/users/:id", getUser)
	v1.POST("/users", createUser)
	r.GET("/health", health)
}`,
		});

		expect(routesOf(project)).toEqual([
			"GET /api/v1/users",
			"GET /api/v1/users/{id}",
			"GET /health",
			"POST /api/v1/users",
		]);
	});

	it("scopes a Chi Route block to its closure", () => {
		const project = createProject({
			"router.go": `package main

func routes() {
	r := chi.NewRouter()
	r.Route("/admin", func(r chi.Router) {
		r.Get("/stats", stats)
		r.Post("/purge", purge)
	})
	r.Get("/ping", ping)
}`,
		});

		expect(routesOf(project)).toEqual([
			"GET /admin/stats",
			"GET /ping",
			"POST /admin/purge",
		]);
	});
});
