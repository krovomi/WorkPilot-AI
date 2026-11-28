/**
 * The tickets ranked by meaning: the backend runner is started without a
 * shell, with the provider's environment and an app folder for its vectors;
 * what it prints is read back field by field, for the ticket ids it was given.
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	python: "/usr/bin/python3" as string | null,
	spawned: [] as { exe: string; args: string[]; options: Record<string, unknown>; input: unknown }[],
	child: null as null | (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }),
	spawnThrows: false,
	settings: {} as Record<string, unknown> | undefined,
	settingsThrow: false,
	packaged: false,
}));

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return state.packaged;
		},
		getAppPath: () => "/app/frontend",
		getPath: () => "/user-data",
	},
}));
vi.mock("../../app-logger", () => ({ appLog: { debug: vi.fn() } }));
vi.mock("../../utils/ensure-python", () => ({ readyPythonPath: async () => state.python }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: async () => ({ SELECTED_LLM_PROVIDER: "openai" }) }));
vi.mock("../../python-detector", () => ({ parsePythonCommand: (p: string) => [p, ["-I"]] }));
vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => {
		if (state.settingsThrow) throw new Error("unreadable");
		return state.settings;
	},
}));
vi.mock("node:child_process", () => ({
	spawn: (exe: string, args: string[], options: Record<string, unknown>) => {
		if (state.spawnThrows) throw new Error("no python");
		const inputPath = args[args.indexOf("--input") + 1] as string;
		state.spawned.push({ exe, args, options, input: JSON.parse(readFileSync(inputPath, "utf-8")) });
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: vi.fn(() => child.emit("close", null)),
		});
		state.child = child;
		return child;
	},
}));

import {
	createSemanticSearch,
	EMBED_RUNNER,
	parseSemanticOutput,
	readSemanticMode,
	runEmbedRunner,
	SEMANTIC_MARKER,
	semanticMode,
} from "../semantic-search";

const ids = new Set(["t1", "t2"]);
const line = (payload: unknown) => `noise\n${SEMANTIC_MARKER}${JSON.stringify(payload)}\n`;
const ranking = {
	source: { kind: "cloud", provider: "openai", model: "text-embedding-3-small" },
	scores: [
		{ id: "t2", score: 0.4 },
		{ id: "t1", score: 0.9 },
	],
	indexed: 2,
	total: 2,
};

beforeEach(() => {
	state.python = "/usr/bin/python3";
	state.spawned = [];
	state.child = null;
	state.spawnThrows = false;
	state.settings = {};
	state.settingsThrow = false;
	state.packaged = false;
});

describe("parseSemanticOutput", () => {
	it("reads the ranking, best first", () => {
		expect(parseSemanticOutput(line(ranking), ids)).toEqual({
			...ranking,
			scores: [
				{ id: "t1", score: 0.9 },
				{ id: "t2", score: 0.4 },
			],
		});
	});

	it("keeps only the ids it asked, once, and bounds the counts", () => {
		const parsed = parseSemanticOutput(
			line({ ...ranking, scores: [{ id: "x", score: 1 }, ...ranking.scores, { id: "t1", score: 0.1 }], indexed: 9, total: 9 }),
			ids,
		);
		expect(parsed?.scores.map((s) => s.id)).toEqual(["t1", "t2"]);
		expect([parsed?.indexed, parsed?.total]).toEqual([2, 2]);
	});

	it("fills in missing counts", () => {
		const { indexed: _i, total: _t, ...bare } = ranking;
		expect(parseSemanticOutput(line(bare), ids)).toMatchObject({ indexed: 2, total: 2 });
	});

	it.each([
		["", "no marker"],
		[`${SEMANTIC_MARKER}{not json`, "not JSON"],
		[line({ source: null, scores: [] }), "no model"],
		[line({ ...ranking, source: { kind: "remote", provider: "x", model: "y" } }), "unknown kind"],
		[line({ ...ranking, scores: [{ id: "t1", score: "high" }] }), "a score that is not a number"],
		[line({ ...ranking, scores: [{ id: "other", score: 1 }] }), "no id it asked"],
	])("gives nothing for %j (%s)", (stdout) => {
		expect(parseSemanticOutput(stdout, ids)).toBeNull();
	});
});

describe("semanticMode", () => {
	it("reads a mode of the closed list, auto otherwise", () => {
		expect(semanticMode({ boardAskSemantic: "local" })).toBe("local");
		expect(semanticMode({ boardAskSemantic: "off" })).toBe("off");
		expect(semanticMode({ boardAskSemantic: "everywhere" as never })).toBe("auto");
		expect(semanticMode(undefined)).toBe("auto");
	});

	it("reads it from the settings file, auto when it cannot", () => {
		state.settings = { boardAskSemantic: "local" };
		expect(readSemanticMode()).toBe("local");
		state.settings = undefined;
		expect(readSemanticMode()).toBe("auto");
		state.settingsThrow = true;
		expect(readSemanticMode()).toBe("auto");
	});
});

describe("createSemanticSearch", () => {
	it("is nothing when turned off", () => {
		expect(createSemanticSearch({ projectDir: "/p", mode: "off" })).toBeUndefined();
	});

	it("sends the mode, the folders, the question and the tickets, bounded", async () => {
		const run = vi.fn(async () => line(ranking));
		const search = createSemanticSearch({ projectDir: "/p", mode: "local", run });
		const docs = Array.from({ length: 1600 }, (_, i) => ({ id: i < 2 ? `t${i + 1}` : `d${i}`, text: "x" }));
		const result = await search?.("admin", docs);
		expect(result?.scores[0]?.id).toBe("t1");
		const input = (run.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect(input).toMatchObject({ mode: "local", project_dir: "/p", query: "admin" });
		expect(String(input.cache_dir)).toMatch(/user-data[\\/]board-ask$/);
		expect((input.documents as unknown[]).length).toBe(1500);
	});

	it("asks nothing for an empty question or board, and survives a failing runner", async () => {
		const run = vi.fn(async () => {
			throw new Error("boom");
		});
		const search = createSemanticSearch({ projectDir: "/p", mode: "auto", cacheDir: "/c", run });
		expect(await search?.("  ", [{ id: "t1", text: "x" }])).toBeNull();
		expect(await search?.("q", [])).toBeNull();
		expect(run).not.toHaveBeenCalled();
		expect(await search?.("q", [{ id: "t1", text: "x" }])).toBeNull();
	});
});

describe("runEmbedRunner", () => {
	it("starts the runner by its path, without a shell, and gives back its output", async () => {
		const pending = runEmbedRunner({ query: "q" });
		await vi.waitFor(() => expect(state.child).not.toBeNull());
		const spawned = state.spawned[0];
		expect(spawned?.exe).toBe("/usr/bin/python3");
		expect(spawned?.args[0]).toBe("-I");
		expect(spawned?.args[1]).toMatch(new RegExp(`backend[\\\\/]runners[\\\\/]${EMBED_RUNNER}$`));
		expect(spawned?.options).toMatchObject({ env: { SELECTED_LLM_PROVIDER: "openai" } });
		expect(spawned?.options).not.toHaveProperty("shell");
		expect(spawned?.input).toEqual({ query: "q" });
		const inputPath = spawned?.args[3] as string;
		state.child?.stderr.emit("data", Buffer.from("a warning"));
		state.child?.stdout.emit("data", Buffer.from("out"));
		state.child?.emit("close", 0);
		expect(await pending).toBe("out");
		expect(existsSync(inputPath)).toBe(false);
	});

	it("runs the packaged app's backend, and keeps a bounded output", async () => {
		state.packaged = true;
		Object.assign(process, { resourcesPath: "/opt/app/resources" });
		const pending = runEmbedRunner({});
		await vi.waitFor(() => expect(state.child).not.toBeNull());
		expect(state.spawned[0]?.args[1]).toMatch(/resources[\\/]backend[\\/]runners/);
		state.child?.stdout.emit("data", Buffer.from("x".repeat(4 * 1024 * 1024)));
		state.child?.stdout.emit("data", Buffer.from("dropped"));
		state.child?.emit("close", 0);
		expect((await pending)?.endsWith("dropped")).toBe(false);
	});

	it("is what a search runs by default", async () => {
		state.python = null;
		const search = createSemanticSearch({ projectDir: "/p", mode: "auto" });
		expect(await search?.("q", [{ id: "t1", text: "x" }])).toBeNull();
	});

	it("gives nothing without Python, or when it cannot start or errors", async () => {
		state.python = null;
		expect(await runEmbedRunner({})).toBeNull();
		state.python = "/usr/bin/python3";
		state.spawnThrows = true;
		expect(await runEmbedRunner({})).toBeNull();
		state.spawnThrows = false;
		const pending = runEmbedRunner({});
		await vi.waitFor(() => expect(state.child).not.toBeNull());
		state.child?.emit("error", new Error("ENOENT"));
		expect(await pending).toBeNull();
	});

	it("stops a runner that takes too long", async () => {
		vi.useFakeTimers();
		try {
			const pending = runEmbedRunner({});
			await vi.waitFor(() => expect(state.child).not.toBeNull());
			vi.advanceTimersByTime(46_000);
			expect(state.child?.kill).toHaveBeenCalled();
			expect(await pending).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});
});
