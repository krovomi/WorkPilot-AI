import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const configures = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());

function mockService(name: string) {
	const configure = vi.fn();
	configures.set(name, configure);
	return { [name]: { configure } };
}

vi.mock("../architecture-visualizer-service", () => mockService("architectureVisualizerService"));
vi.mock("../auto-refactor-service", () => mockService("autoRefactorService"));
vi.mock("../code-migration-service", () => mockService("codeMigrationService"));
vi.mock("../code-playground-service", () => mockService("codePlaygroundService"));
vi.mock("../context-mesh-service", () => mockService("contextMeshService"));
vi.mock("../learning-loop-service", () => mockService("learningLoopService"));
vi.mock("../live-companion-service", () => mockService("liveCompanionService"));
vi.mock("../mobile-service", () => mockService("mobileService"));
vi.mock("../natural-language-git-service", () => mockService("naturalLanguageGitService"));
vi.mock("../performance-profiler-service", () => mockService("performanceProfilerService"));
vi.mock("../pipeline-generator-service", () => mockService("pipelineGeneratorService"));
vi.mock("../spec-interview-service", () => mockService("specInterviewService"));
vi.mock("../visual-programming-service", () => mockService("visualProgrammingService"));
vi.mock("../voice-control-service", () => mockService("voiceControlService"));

import { configurePythonFeatureServices } from "../python-feature-services";

describe("configurePythonFeatureServices", () => {
	beforeEach(() => {
		for (const configure of configures.values()) configure.mockClear();
	});

	it("gives every feature service the managed Python and backend", () => {
		configurePythonFeatureServices("/venv/bin/python", "/app/backend");
		expect(configures.size).toBe(14);
		for (const [name, configure] of configures) {
			expect(configure, name).toHaveBeenCalledWith(
				"/venv/bin/python",
				"/app/backend",
			);
		}
	});

	it("covers every main-process service that takes a Python path", () => {
		// A service left out of the list keeps its default "python" (the
		// system interpreter, without the backend's dependencies): six did.
		const mainDir = path.resolve(import.meta.dirname, "..");
		// The list, or the services project-handlers configures one by one.
		const list =
			readFileSync(path.join(mainDir, "python-feature-services.ts"), "utf-8") +
			readFileSync(
				path.join(mainDir, "ipc-handlers", "project-handlers.ts"),
				"utf-8",
			);
		const missing = readdirSync(mainDir)
			.filter((f) => f.endsWith("-service.ts"))
			.filter((f) =>
				/\bconfigure\(\s*pythonPath\??: string/.test(
					readFileSync(path.join(mainDir, f), "utf-8"),
				),
			)
			.filter((f) => {
				const source = readFileSync(path.join(mainDir, f), "utf-8");
				const instance = /export const (\w+) = new /.exec(source)?.[1];
				return !(
					list.includes(`"./${f.replace(/\.ts$/, "")}"`) ||
					(instance && list.includes(`${instance}.configure(`))
				);
			});
		expect(missing).toEqual([]);
	});
});
