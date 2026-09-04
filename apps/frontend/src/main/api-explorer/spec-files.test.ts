import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCommittedSpec } from "./spec-files";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-spec-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Orders
  version: "1.2.0"
paths:
  /orders:
    get:
      summary: List orders
      responses:
        "200":
          description: OK
  /orders/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
`;

const SWAGGER_JSON = JSON.stringify({
	swagger: "2.0",
	info: { title: "Legacy", version: "1.0" },
	paths: { "/legacy": { get: { responses: { "200": {} } } } },
});

describe("findCommittedSpec", () => {
	it("reads an OpenAPI document written in YAML", () => {
		const spec = findCommittedSpec(
			createProject({ "openapi.yaml": OPENAPI_YAML }),
		);

		expect(spec?.dialect).toBe("openapi3");
		expect(spec?.pathCount).toBe(2);
		expect(spec?.relativePath).toBe("openapi.yaml");
		expect(Object.keys(spec?.document.paths as object)).toEqual([
			"/orders",
			"/orders/{id}",
		]);
	});

	it("reads a Swagger 2 document written in JSON", () => {
		const spec = findCommittedSpec(
			createProject({ "swagger.json": SWAGGER_JSON }),
		);

		expect(spec?.dialect).toBe("swagger2");
		expect(spec?.pathCount).toBe(1);
	});

	it("prefers OpenAPI 3 over Swagger 2", () => {
		const spec = findCommittedSpec(
			createProject({
				"swagger.json": SWAGGER_JSON,
				"docs/openapi.yaml": OPENAPI_YAML,
			}),
		);

		expect(spec?.relativePath).toBe(path.join("docs", "openapi.yaml"));
	});

	it("prefers the document covering more paths, then the shallower one", () => {
		const oneP = 'openapi: "3.0.0"\npaths:\n  /a:\n    get:\n      responses: {}\n';
		const twoP = `${oneP}  /b:\n    get:\n      responses: {}\n`;

		expect(
			findCommittedSpec(
				createProject({ "openapi.yaml": oneP, "api/openapi.yaml": twoP }),
			)?.relativePath,
		).toBe(path.join("api", "openapi.yaml"));

		expect(
			findCommittedSpec(
				createProject({ "openapi.yaml": twoP, "api/openapi.yaml": twoP }),
			)?.relativePath,
		).toBe("openapi.yaml");
	});

	it("ignores files that are named like a spec but are not one", () => {
		const project = createProject({
			"openapi.json": "{ this is not json",
			"swagger.yaml": "just: a mapping\nwithout: paths\n",
			"api-docs.yml": "openapi: 3.0.0\npaths: {}\n",
		});

		expect(findCommittedSpec(project)).toBeNull();
	});

	it("does not read vendored copies", () => {
		const project = createProject({
			"node_modules/some-lib/openapi.yaml": OPENAPI_YAML,
			"obj/openapi.yaml": OPENAPI_YAML,
		});

		expect(findCommittedSpec(project)).toBeNull();
	});

	it("returns null for a project that carries no spec", () => {
		expect(
			findCommittedSpec(createProject({ "README.md": "# nothing here" })),
		).toBeNull();
	});

	it("survives a YAML bomb instead of hanging on it", () => {
		const bomb = [
			"openapi: 3.0.0",
			"a: &a [x, x, x, x, x, x, x, x, x]",
			"b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
			"c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
			"d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
			"e: [*d, *d, *d, *d, *d, *d, *d, *d, *d]",
			"paths:",
			"  /a:",
			"    get:",
			"      responses: {}",
		].join("\n");

		const started = Date.now();
		findCommittedSpec(createProject({ "openapi.yaml": bomb }));

		expect(Date.now() - started).toBeLessThan(2000);
	});
});
