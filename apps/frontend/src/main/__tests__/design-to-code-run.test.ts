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
});
