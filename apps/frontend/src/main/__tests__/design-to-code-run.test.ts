/**
 * Import Design runs the runner with arguments built from a revalidated
 * request: the render loop is asked for only by a strict `true`.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn,
}));
vi.mock("electron", () => ({
	app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
}));
vi.mock("../project-store", () => ({
	projectStore: { getProject: () => undefined, getProjects: () => [] },
}));
vi.mock("../python-env-manager", () => ({ pythonEnvManager: { getPythonPath: () => null } }));
vi.mock("../updater/path-resolver", () => ({ getEffectiveSourcePath: () => tmpdir() }));
vi.mock("../utils/python-runner-env", () => ({ pythonRunnerEnv: async () => ({}) }));
vi.mock("../app-language", () => ({ getAppLanguage: () => "en" }));
vi.mock("../generated-review/review-card", () => ({ findOpenReviewCard: () => null }));
vi.mock("../generated-review/review-run", () => ({
	findLocalProject: () => undefined,
	openReviewRun: () => Promise.reject(new Error("no review run in this test")),
}));

import { RENDER_LOOP_MAX_MASKS } from "../../shared/constants/design-render-loop";
import { renderLoopArgs } from "../design-render-loop-args";
import { DesignToCodeService } from "../design-to-code-service";

let source: string;

/** A runner that prints its result and exits. */
function fakeRunner() {
	const proc = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
	queueMicrotask(() => {
		proc.stdout.emit("data", Buffer.from('__DESIGN_TO_CODE_RESULT__:{"success":true}\n'));
		proc.emit("close", 0);
	});
	return proc;
}

async function argsFor(request: Record<string, unknown>): Promise<string[]> {
	const service = new DesignToCodeService();
	service.configure(source);
	await service.run({ figmaUrl: "https://www.figma.com/file/x", ...request } as never);
	return spawn.mock.calls.at(-1)?.[1] as string[];
}

beforeEach(() => {
	source = mkdtempSync(path.join(tmpdir(), "dtc-run-"));
	mkdirSync(path.join(source, "runners"));
	writeFileSync(path.join(source, "runners", "design_to_code_runner.py"), "");
	spawn.mockReset();
	spawn.mockImplementation(fakeRunner);
});

afterEach(() => {
	rmSync(source, { recursive: true, force: true });
});

describe("DesignToCodeService.run", () => {
	it("asks for the render loop only when the request says true", async () => {
		expect(await argsFor({ renderLoop: true })).toContain("--render-loop");
		expect(await argsFor({ renderLoop: false })).not.toContain("--render-loop");
		expect(await argsFor({ renderLoop: "yes" })).not.toContain("--render-loop");
		expect(await argsFor({})).not.toContain("--render-loop");
	});

	it("passes the loop's options only with the loop, and only within bounds", async () => {
		const options = {
			maxIterations: 3,
			threshold: 0.9,
			maxTokens: 200_000,
			maxCostUsd: 1,
			responsive: true,
			states: true,
		};
		const args = await argsFor({ renderLoop: true, renderLoopOptions: options });
		expect(args.slice(args.indexOf("--render-loop"))).toEqual(
			expect.arrayContaining([
				"--loop-max-iterations",
				"3",
				"--loop-threshold",
				"0.9",
				"--loop-max-tokens",
				"200000",
				"--loop-max-cost",
				"1",
				"--loop-responsive",
				"--loop-states",
			]),
		);
		expect(await argsFor({ renderLoopOptions: options })).not.toContain("--loop-states");
	});
});

describe("renderLoopArgs", () => {
	it("drops what is not a bounded number or a strict true", () => {
		expect(renderLoopArgs(undefined)).toEqual([]);
		expect(renderLoopArgs("--loop-states")).toEqual([]);
		expect(
			renderLoopArgs({
				maxIterations: 2.5,
				threshold: 1.2,
				maxTokens: "400000",
				maxCostUsd: Number.NaN,
				responsive: "true",
				states: 1,
			}),
		).toEqual([]);
		expect(renderLoopArgs({ maxIterations: 0, maxTokens: 9_000_000, maxCostUsd: 0 })).toEqual([]);
		expect(renderLoopArgs({ maxIterations: 10, threshold: 0.5 })).toEqual([
			"--loop-max-iterations",
			"10",
			"--loop-threshold",
			"0.5",
		]);
	});

	it("passes the fix only on a strict true and each drawn zone inside the design", () => {
		expect(renderLoopArgs({ fixPasses: "true", masks: "0,0,1,1" })).toEqual([]);
		expect(
			renderLoopArgs({
				fixPasses: true,
				masks: [
					{ x: 0, y: 0.5, w: 1, h: 0.25 },
					null,
					"0,0,1,1",
					{ x: 0.5, y: 0, w: 0.6, h: 0.5 },
					{ x: 0, y: 0, w: 0, h: 0.5 },
					{ x: 0, y: 0, w: 0.5, h: -0.1 },
					{ x: 0, y: 0.9, w: 0.5, h: 0.2 },
					{ x: Number.NaN, y: 0, w: 0.5, h: 0.5 },
					{ x: "0", y: 0, w: 0.5, h: 0.5 },
					{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
				],
			}),
		).toEqual(["--loop-fix-passes", "--loop-mask", "0,0.5,1,0.25", "--loop-mask", "0.1,0.2,0.3,0.4"]);
	});

	it("passes at most the runner's number of zones", () => {
		const masks = Array.from({ length: RENDER_LOOP_MAX_MASKS + 3 }, () => ({ x: 0, y: 0, w: 0.5, h: 0.5 }));
		const args = renderLoopArgs({ masks });
		expect(args.filter((arg) => arg === "--loop-mask")).toHaveLength(RENDER_LOOP_MAX_MASKS);
	});
});
