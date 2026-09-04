import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildProbeUrls,
	discoverBaseUrls,
	parseSpecBody,
	probeLiveSpec,
	type SpecFetcher,
	specPathsFor,
} from "./live-spec";

const projects: string[] = [];

afterEach(() => {
	for (const project of projects.splice(0)) {
		rmSync(project, { recursive: true, force: true });
	}
});

function createProject(files: Record<string, string>): string {
	const project = mkdtempSync(path.join(tmpdir(), "workpilot-live-"));
	projects.push(project);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(project, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return project;
}

const OPENAPI = JSON.stringify({
	openapi: "3.0.0",
	info: { title: "x", version: "1" },
	paths: { "/things": { get: { responses: { "200": {} } } } },
});

describe("discoverBaseUrls", () => {
	it("reads .NET launch profiles, https included", () => {
		const project = createProject({
			"Properties/launchSettings.json": JSON.stringify({
				profiles: {
					http: { applicationUrl: "http://localhost:5180" },
					https: { applicationUrl: "https://localhost:7180;http://localhost:5180" },
				},
			}),
		});

		expect(discoverBaseUrls(project, [])).toEqual([
			"http://localhost:5180",
			"https://localhost:7180",
		]);
	});

	it("reads the address a .http request file calls, loopback only", () => {
		const project = createProject({
			"src/Rag.Api/Rag.Api.http": `@Rag.Api_HostAddress = http://localhost:5180

GET {{Rag.Api_HostAddress}}/api/documents/
Accept: application/json

### Production — must never be probed from here
GET https://rag.example.com/api/documents/
`,
		});

		expect(discoverBaseUrls(project, [])).toEqual(["http://localhost:5180"]);
	});

	it("reads a Spring port, an env PORT and a compose host port", () => {
		expect(
			discoverBaseUrls(
				createProject({ "src/main/resources/application.properties": "server.port=8081\n" }),
				[],
			),
		).toContain("http://127.0.0.1:8081");

		expect(
			discoverBaseUrls(createProject({ ".env": "DEBUG=1\nPORT=4321\n" }), []),
		).toContain("http://127.0.0.1:4321");

		expect(
			discoverBaseUrls(
				createProject({
					"docker-compose.yml": 'services:\n  api:\n    ports:\n      - "8085:8080"\n',
				}),
				[],
			),
		).toContain("http://127.0.0.1:8085");
	});

	it("reads a port out of package.json scripts, never out of a version", () => {
		const urls = discoverBaseUrls(
			createProject({
				"package.json": JSON.stringify({
					dependencies: { express: "4.18.2" },
					scripts: { start: "node server.js --port 4010" },
				}),
			}),
			[],
		);

		expect(urls).toEqual(["http://127.0.0.1:4010"]);
	});

	it("puts framework defaults after anything the project configures", () => {
		const urls = discoverBaseUrls(
			createProject({ ".env": "PORT=4321\n" }),
			["FastAPI"],
		);

		expect(urls).toEqual([
			"http://127.0.0.1:4321",
			"http://127.0.0.1:8000",
		]);
	});
});

describe("specPathsFor / buildProbeUrls", () => {
	it("puts the framework's own endpoints before the generic ones", () => {
		const paths = specPathsFor(["Spring Boot"]);

		expect(paths[0]).toBe("/v3/api-docs");
		expect(paths).toContain("/openapi.json");
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("goes breadth first over base URLs and honours the cap", () => {
		const urls = buildProbeUrls(
			["http://a", "http://b"],
			["FastAPI"],
			4,
		);

		expect(urls).toEqual([
			"http://a/openapi.json",
			"http://b/openapi.json",
			"http://a/swagger.json",
			"http://b/swagger.json",
		]);
	});
});

describe("parseSpecBody", () => {
	it("reads JSON and YAML, and refuses anything else", () => {
		expect(parseSpecBody(OPENAPI)).toMatchObject({ openapi: "3.0.0" });
		expect(parseSpecBody("openapi: 3.0.0\npaths: {}\n")).toMatchObject({
			openapi: "3.0.0",
		});
		expect(parseSpecBody("<html><body>404</body></html>")).toBeNull();
		expect(parseSpecBody("")).toBeNull();
		expect(parseSpecBody("[1, 2, 3]")).toBeNull();
	});
});

describe("probeLiveSpec", () => {
	const serving =
		(answers: Record<string, string>): SpecFetcher =>
		async (url) =>
			answers[url] ?? null;

	it("returns the earliest-ranked answer, not the fastest", async () => {
		const fetcher: SpecFetcher = async (url) => {
			// The lower-ranked URL answers first; ordering must still decide.
			if (url === "http://b/openapi.json") return OPENAPI;
			if (url === "http://a/openapi.json") {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return OPENAPI;
			}
			return null;
		};

		const found = await probeLiveSpec(
			["http://a/openapi.json", "http://b/openapi.json"],
			fetcher,
		);

		expect(found?.url).toBe("http://a/openapi.json");
		expect(found?.pathCount).toBe(1);
	});

	it("ignores answers that are not an API description", async () => {
		const found = await probeLiveSpec(
			["http://a/openapi.json", "http://a/swagger.json"],
			serving({
				"http://a/openapi.json": "<html>not found</html>",
				"http://a/swagger.json": OPENAPI,
			}),
		);

		expect(found?.url).toBe("http://a/swagger.json");
	});

	it("returns null rather than propagating a fetch failure", async () => {
		const found = await probeLiveSpec(["http://a/openapi.json"], async () => {
			throw new Error("ECONNREFUSED");
		});

		expect(found).toBeNull();
	});

	it("stops at the total budget instead of waiting on every candidate", async () => {
		const urls = Array.from({ length: 24 }, (_, i) => `http://a/${i}.json`);
		const hangs: SpecFetcher = (_url, timeoutMs) =>
			new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));

		const started = Date.now();
		const found = await probeLiveSpec(urls, hangs, {
			requestTimeoutMs: 30,
			totalBudgetMs: 120,
			concurrency: 4,
		});
		const elapsed = Date.now() - started;

		expect(found).toBeNull();
		expect(elapsed).toBeLessThan(400);
	});
});
