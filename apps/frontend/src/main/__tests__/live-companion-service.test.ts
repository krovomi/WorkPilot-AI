/**
 * The Live Companion service: it sees changes, keeps suggestions per
 * project, reports why an analysis failed and proposes a takeover only when
 * the developer stopped.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { home } = vi.hoisted(() => {
	const fs = require("node:fs") as typeof import("node:fs");
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	return {
		home: fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "wp-companion-home-")),
	};
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const patched = { ...actual, homedir: () => home };
	return { ...patched, default: patched };
});
vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => process.cwd() },
}));
vi.mock("../utils/python-runner-env", () => ({
	pythonRunnerEnv: vi.fn(async () => ({})),
}));
vi.mock("../app-language", () => ({ getAppLanguage: () => "fr" }));

const spawned = vi.hoisted(
	() => [] as { command: string; args: string[]; stdin: string[] }[],
);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	const spawn = (command: string, args: string[]) => {
		const record = { command, args, stdin: [] as string[] };
		spawned.push(record);
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			stdin: Object.assign(new EventEmitter(), {
				end: (chunk: string) => record.stdin.push(chunk),
			}),
			kill: () => true,
		});
		return proc;
	};
	return { ...actual, spawn, default: { ...actual, spawn } };
});

import type {
	CompanionState,
	FileChangeEvent,
	LiveSuggestion,
	TakeoverProposal,
} from "../../shared/types/live-companion";
import { LiveCompanionService } from "../live-companion-service";

type Internals = {
	handleRunnerOutput(
		projectDir: string,
		stdout: string,
		stderr: string,
		exitCode: number | null,
	): void;
	checkForTakeover(config: ReturnType<LiveCompanionService["getConfig"]>): void;
	fileActivityMap: Map<string, { lastChange: number; changeCount: number }>;
	lastActivity: number;
	state: CompanionState;
};

const line = (event: unknown) => `LIVE_COMPANION_EVENT:${JSON.stringify(event)}`;

function suggestion(id: string): LiveSuggestion {
	return {
		suggestion_id: id,
		suggestion_type: "bug_detection",
		priority: "high",
		title: "Null check",
		description: "b may be undefined",
		file_path: "src/a.ts",
		line_start: 3,
		line_end: 3,
		code_fix: "",
		related_files: [],
		confidence: 0.9,
		created_at: "2026-11-14T10:00:00Z",
		status: "active",
	};
}

let project: string;
let service: LiveCompanionService;

beforeEach(() => {
	rmSync(path.join(home, ".workpilot"), { recursive: true, force: true });
	project = mkdtempSync(path.join(os.tmpdir(), "wp-companion-project-"));
	service = new LiveCompanionService();
});

afterEach(() => {
	service.stop();
	rmSync(project, { recursive: true, force: true });
});

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("watching", () => {
	it("sees a file saved in the project (chokidar without globs)", async () => {
		mkdirSync(path.join(project, "src"));
		service.updateConfig({ suggestion_enabled: false });
		const changes: FileChangeEvent[] = [];
		service.on("file-change", (event: FileChangeEvent) => changes.push(event));

		expect(await service.start(project)).toBe(true);
		// Let chokidar finish its initial scan before writing.
		await new Promise((resolve) => setTimeout(resolve, 500));
		writeFileSync(path.join(project, "src", "main.dart"), "void main() {}\n");
		mkdirSync(path.join(project, "node_modules"));
		writeFileSync(path.join(project, "node_modules", "x.js"), "x\n");

		await vi.waitFor(
			() => expect(changes.map((c) => c.file_path)).toContain(path.join("src", "main.dart")),
			{ timeout: 8000, interval: 100 },
		);
		const change = changes.find((c) => c.file_path.endsWith("main.dart"));
		expect(change?.language).toBe("Dart");
		expect(change?.content_kind).toBe("file");
		expect(change?.diff).toContain("void main()");
		expect(changes.some((c) => c.file_path.includes("node_modules"))).toBe(false);
		expect(service.getState().changes_detected).toBeGreaterThan(0);
	}, 15_000);
});

describe("runner output", () => {
	it("stores suggestions for their project only", () => {
		const internals = service as unknown as Internals;
		const pushed: LiveSuggestion[] = [];
		service.on("suggestion", (s: LiveSuggestion) => pushed.push(s));

		internals.handleRunnerOutput(
			project,
			line({ type: "complete", data: { suggestions: [suggestion("sug-1")] } }),
			"",
			0,
		);

		expect(pushed[0].project_dir).toBe(project);
		expect(service.getSuggestions(project).map((s) => s.suggestion_id)).toEqual([
			"sug-1",
		]);
		expect(service.getSuggestions(path.join(os.tmpdir(), "elsewhere"))).toEqual([]);
		expect(service.getState().suggestions_generated).toBe(1);
	});

	it("keeps the reason of a failed analysis for the page", () => {
		const internals = service as unknown as Internals;
		internals.handleRunnerOutput(
			project,
			line({
				type: "error",
				data: { message: "invalid api key", code: "auth_failed", provider: "mistral" },
			}),
			"",
			1,
		);

		expect(service.getState().last_error).toMatchObject({
			message: "invalid api key",
			code: "auth_failed",
			provider: "mistral",
		});

		internals.handleRunnerOutput(
			project,
			line({ type: "complete", data: { suggestions: [], errors: [] } }),
			"",
			0,
		);
		expect(service.getState().last_error).toBeNull();
	});

	it("explains a runner that crashed before saying anything", () => {
		(service as unknown as Internals).handleRunnerOutput(
			project,
			"",
			"Traceback (most recent call last):\nModuleNotFoundError: No module named 'x'\n",
			1,
		);
		expect(service.getState().last_error).toMatchObject({
			code: "runner_crashed",
			message: expect.stringContaining("ModuleNotFoundError"),
		});
	});

	it("does not emit an 'error' event nobody listens to", () => {
		expect(() =>
			(service as unknown as Internals).handleRunnerOutput(project, "", "", 1),
		).not.toThrow();
	});
});

describe("analysis", () => {
	it("hands the changes to the runner on stdin, not in a temp file", async () => {
		spawned.length = 0;
		const backend = mkdtempSync(path.join(os.tmpdir(), "wp-companion-backend-"));
		mkdirSync(path.join(backend, "runners"));
		writeFileSync(path.join(backend, "runners", "live_companion_runner.py"), "");
		service.configure("python3", backend);
		const internals = service as unknown as Internals & {
			pendingChanges: FileChangeEvent[];
			analyzePendingChanges(projectDir: string): Promise<void>;
		};
		internals.state = { ...internals.state, active: true, watching_project: project };
		internals.pendingChanges = [
			{
				file_path: "src/a.ts",
				change_type: "modified",
				diff: "+const secretish = 1;",
				content_kind: "diff",
				language: "TypeScript",
				timestamp: "2026-11-14T10:00:00Z",
			},
		];

		await internals.analyzePendingChanges(project);

		expect(spawned).toHaveLength(1);
		const { args, stdin } = spawned[0];
		expect(args[args.indexOf("--changes-file") + 1]).toBe("-");
		expect(args).toContain("--language");
		expect(JSON.parse(stdin.join("")).changes[0].diff).toBe("+const secretish = 1;");
		expect(service.getState().analyzing).toBe(true);
		rmSync(backend, { recursive: true, force: true });
	});
});

describe("takeover", () => {
	function stoppedAfter(edits: number, secondsAgo: number) {
		const internals = service as unknown as Internals;
		const at = Date.now() - secondsAgo * 1000;
		internals.state = { ...internals.state, active: true, watching_project: project };
		internals.fileActivityMap.set("src/a.ts", { lastChange: at, changeCount: edits });
		internals.lastActivity = at;
		return internals;
	}

	it("is proposed after several edits and a pause of the whole project", () => {
		const proposals: TakeoverProposal[] = [];
		service.on("takeover-proposal", (p: TakeoverProposal) => proposals.push(p));
		const internals = stoppedAfter(4, 200);

		internals.checkForTakeover(service.getConfig());

		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			file_path: "src/a.ts",
			reason: "inactivity",
			change_count: 4,
			project_dir: project,
		});
		expect(service.getTakeovers(project)).toHaveLength(1);
		// One proposal per pause.
		internals.checkForTakeover(service.getConfig());
		expect(proposals).toHaveLength(1);
	});

	it("is not proposed while the developer works on another file", () => {
		const proposals: TakeoverProposal[] = [];
		service.on("takeover-proposal", (p: TakeoverProposal) => proposals.push(p));
		const internals = stoppedAfter(4, 200);
		internals.lastActivity = Date.now();

		internals.checkForTakeover(service.getConfig());

		expect(proposals).toHaveLength(0);
	});

	it("is not proposed after a single edit", () => {
		const proposals: TakeoverProposal[] = [];
		service.on("takeover-proposal", (p: TakeoverProposal) => proposals.push(p));
		stoppedAfter(1, 200).checkForTakeover(service.getConfig());
		expect(proposals).toHaveLength(0);
	});
});

describe("config", () => {
	it("writes only what the user changed, and type-checks it", () => {
		const config = service.updateConfig({
			takeover_enabled: false,
			// A hostile renderer value.
			watch_debounce_ms: "fast" as unknown as number,
		});
		expect(config.takeover_enabled).toBe(false);
		expect(config.watch_debounce_ms).toBe(1500);
		expect(config.watch_patterns).toContain("**/*.dart");
	});
});
