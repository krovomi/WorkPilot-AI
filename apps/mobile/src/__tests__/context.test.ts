import { readIndex } from "../context/index-file";

describe("the project's index, read defensively", () => {
	it("keeps the services, infrastructure and conventions it recognises", () => {
		const index = readIndex(
			JSON.stringify({
				project_root: "/srv/repos/secret-path",
				project_type: "monorepo",
				services: {
					api: { name: "api", path: "apps/api", language: "Python", framework: "FastAPI", type: "backend", default_port: 9000 },
					web: { path: "apps/web", language: "TypeScript", type: "unknown", default_port: "3000" },
					broken: "not an object",
				},
				infrastructure: { docker_compose: "compose.yml", ci_workflows: ["ci.yml", "", 3, "release.yml"], other: "x" },
				conventions: { typescript: true, git_hooks: false, js_linting: "Biome" },
			}),
		);
		expect(index).toEqual({
			projectType: "monorepo",
			services: [
				{ name: "api", path: "apps/api", labels: ["Python", "FastAPI", "backend"], port: 9000 },
				{ name: "web", path: "apps/web", labels: ["TypeScript"], port: null },
			],
			infrastructure: [
				{ key: "docker_compose", value: "compose.yml" },
				{ key: "ci_workflows", value: "ci.yml, release.yml" },
			],
			conventions: [
				{ key: "js_linting", value: "Biome" },
				{ key: "typescript", value: "✓" },
			],
		});
		// The server's own path is never part of what is shown.
		expect(JSON.stringify(index)).not.toContain("secret-path");
	});

	it("bounds long lists", () => {
		const many = Array.from({ length: 30 }, (_, i) => `w${i}.yml`);
		const index = readIndex(JSON.stringify({ infrastructure: { ci_workflows: many } }));
		expect(index?.infrastructure[0].value.endsWith(", +10")).toBe(true);
	});

	it("is null for a missing or broken file", () => {
		expect(readIndex(undefined)).toBeNull();
		expect(readIndex("{not json")).toBeNull();
		expect(readIndex("[1,2]")).toBeNull();
	});
});
