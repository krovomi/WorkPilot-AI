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
vi.mock("../documentation-agent-service", () => mockService("documentationAgentService"));
vi.mock("../performance-profiler-service", () => mockService("performanceProfilerService"));
vi.mock("../pipeline-generator-service", () => mockService("pipelineGeneratorService"));
vi.mock("../visual-programming-service", () => mockService("visualProgrammingService"));
vi.mock("../voice-control-service", () => mockService("voiceControlService"));

import { configurePythonFeatureServices } from "../python-feature-services";

describe("configurePythonFeatureServices", () => {
	beforeEach(() => {
		for (const configure of configures.values()) configure.mockClear();
	});

	it("gives every feature service the managed Python and backend", () => {
		configurePythonFeatureServices("/venv/bin/python", "/app/backend");
		expect(configures.size).toBe(8);
		for (const [name, configure] of configures) {
			expect(configure, name).toHaveBeenCalledWith(
				"/venv/bin/python",
				"/app/backend",
			);
		}
	});
});
