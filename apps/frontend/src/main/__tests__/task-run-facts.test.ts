/**
 * @vitest-environment node
 *
 * Who created and launched a task, and what it spent, on real files: the
 * people noted beside the spec, the ledger of every provider added up per
 * card (root and task workspaces), sessions that reported nothing left
 * unknown, a server's snapshot files checked again, and the task the board
 * loads carrying them (local project and server mirror).
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

let testDir = "";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn((name: string) =>
			name === "userData" ? path.join(testDir, "userData") : testDir,
		),
	},
}));

vi.mock("../cli-tool-manager", () => ({
	getToolPath: vi.fn(() => "git"),
	getToolPathAsync: vi.fn(async () => "git"),
}));

const facts = await import("../task-run-facts");

const named = (name: string) => () => name;

function specDir(project: string, name: string): string {
	const dir = path.join(project, ".workpilot", "specs", name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeLedger(dir: string, usages: unknown[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "cost_data.json"), JSON.stringify({ usages }), "utf-8");
}

function usage(spec: string, extra: Record<string, unknown> = {}) {
	return {
		spec_id: spec,
		provider: "anthropic",
		model: "claude-sonnet",
		input_tokens: 1000,
		output_tokens: 200,
		cache_creation_input_tokens: 10,
		cache_read_input_tokens: 90,
		cost: 0.25,
		usage_source: "reported",
		timestamp: "2026-11-27T10:00:00Z",
		...extra,
	};
}

function task(specId: string, extra: Partial<Task> = {}): Task {
	return {
		id: specId,
		specId,
		projectId: "p",
		title: specId,
		description: "",
		status: "done",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...extra,
	};
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(tmpdir(), "run-facts-"));
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	facts.forgetIdentities();
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(testDir, { recursive: true, force: true });
});

describe("the people of a card", () => {
	it("notes the creator and the launcher of each run", () => {
		const dir = specDir(testDir, "001-a");
		facts.recordTaskCreator(dir, testDir, "person", named("Alice"));
		facts.recordTaskLauncher(dir, testDir, named("Alice"), new Date("2026-11-27T09:00:00Z"));
		facts.recordTaskLauncher(dir, testDir, named("Bob"), new Date("2026-11-27T10:00:00Z"));

		const written = JSON.parse(readFileSync(path.join(dir, facts.PEOPLE_FILE), "utf-8"));
		expect(written.version).toBe(1);
		expect(facts.readPeople(dir)).toEqual({
			createdBy: { kind: "person", name: "Alice", at: expect.any(String) },
			startedBy: { kind: "person", name: "Bob", at: "2026-11-27T10:00:00.000Z" },
		});
	});

	it("credits an automation without a name", () => {
		const dir = specDir(testDir, "001-a");
		facts.recordTaskCreator(dir, testDir, "automation", named("Alice"));
		expect(facts.readPeople(dir).createdBy).toEqual({
			kind: "automation",
			at: expect.any(String),
		});
	});

	it("fails nothing when the file cannot be written", () => {
		const missing = path.join(testDir, "gone", "001-a");
		expect(() => facts.recordTaskLauncher(missing, testDir, named("A"))).not.toThrow();
		expect(() => facts.recordTaskCreator(missing, testDir)).not.toThrow();
		expect(console.warn).toHaveBeenCalled();
	});

	it("reads only well-formed people from a damaged file", () => {
		const dir = specDir(testDir, "001-a");
		writeFileSync(
			path.join(dir, facts.PEOPLE_FILE),
			JSON.stringify({
				createdBy: { kind: "admin", name: "X" },
				startedBy: { kind: "person", name: "Bo\nb", at: "not a date" },
			}),
			"utf-8",
		);
		expect(facts.readPeople(dir)).toEqual({ startedBy: { kind: "person" } });
		writeFileSync(path.join(dir, facts.PEOPLE_FILE), "{broken", "utf-8");
		expect(facts.readPeople(dir)).toEqual({});
	});

	it("keeps a name to one bounded line", () => {
		expect(facts.cleanName("  Léa  ")).toBe("Léa");
		expect(facts.cleanName("a\tb")).toBeUndefined();
		expect(facts.cleanName("")).toBeUndefined();
		expect(facts.cleanName(42)).toBeUndefined();
		expect(facts.cleanName("x".repeat(300))).toHaveLength(120);
	});

	it("asks git for the name, once a minute, and falls back on the account", () => {
		const fromGit = facts.gitIdentityName(process.execPath, testDir, 0);
		// `node config user.name` is no git: the system account's name is used.
		expect(typeof fromGit === "string" || fromGit === undefined).toBe(true);
		expect(facts.gitIdentityName("/no/such/git", testDir, 1_000)).toBe(fromGit);
		facts.forgetIdentities();
		expect(facts.gitIdentityName("/no/such/git", testDir, 2_000)).toBe(fromGit);
	});
});

describe("what a card spent", () => {
	it("adds up every session of a card, root and task workspaces, all providers", () => {
		writeLedger(path.join(testDir, ".workpilot"), [
			usage("001-a"),
			usage("001-a", { provider: "ollama", model: "llama3", cost: 0, usage_source: "estimated" }),
			usage("002-b"),
			{ task_id: "001-a", input_tokens: 5, timestamp: "x", model: "claude-sonnet" },
			"not a row",
			{ spec_id: "", input_tokens: 99 },
		]);
		writeLedger(
			path.join(testDir, ".workpilot", "worktrees", "tasks", "001-a", ".workpilot"),
			[usage("001-a", { model: "gpt-5" })],
		);

		const spent = facts.usageBySpec(testDir).get("001-a");
		expect(spent).toEqual({
			inputTokens: 3005,
			outputTokens: 600,
			cacheReadTokens: 270,
			cacheWriteTokens: 30,
			costUsd: 0.5,
			sessions: 4,
			estimatedSessions: 1,
			models: ["claude-sonnet", "llama3", "gpt-5"],
		});
	});

	it("reads a ledger again only once it changed", () => {
		const root = path.join(testDir, ".workpilot");
		writeLedger(root, [usage("001-a")]);
		expect(facts.usageBySpec(testDir).get("001-a")?.sessions).toBe(1);
		writeLedger(root, [usage("001-a"), usage("001-a", { input_tokens: 7 })]);
		expect(facts.usageBySpec(testDir).get("001-a")?.sessions).toBe(2);
		rmSync(path.join(root, "cost_data.json"));
		expect(facts.usageBySpec(testDir).get("001-a")).toBeUndefined();
	});

	it("leaves the spend unknown when nothing was reported", () => {
		expect(facts.knownUsage(undefined)).toBeUndefined();
		const silent = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
			sessions: 2,
			estimatedSessions: 0,
			models: [],
		};
		expect(facts.knownUsage(silent)).toBeUndefined();
		expect(facts.knownUsage({ ...silent, costUsd: 0.1 })).toBeDefined();
		expect(facts.knownUsage({ ...silent, sessions: 0, inputTokens: 3 })).toBeUndefined();
	});

	it("checks again the totals a server sent", () => {
		const dir = specDir(testDir, "001-a");
		writeFileSync(
			path.join(dir, facts.USAGE_SUMMARY_FILE),
			JSON.stringify({
				inputTokens: 10,
				outputTokens: -5,
				costUsd: "free",
				sessions: 1.7,
				models: ["m1", 3, "bad\nname", "m2", "m3", "m4"],
			}),
			"utf-8",
		);
		expect(facts.readUsageSummary(dir)).toEqual({
			inputTokens: 10,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
			sessions: 1,
			estimatedSessions: 0,
			models: ["m1", "m2", "m3"],
		});
		writeFileSync(path.join(dir, facts.USAGE_SUMMARY_FILE), "[]", "utf-8");
		expect(facts.readUsageSummary(dir)).toBeUndefined();
	});
});

describe("the facts on the board's tasks", () => {
	const specs = (project: string) => (t: Task) =>
		path.join(project, ".workpilot", "specs", t.specId);

	it("credits a local card to this computer's person unless noted otherwise", () => {
		const launched = specDir(testDir, "001-a");
		facts.recordTaskCreator(launched, testDir, "person", named("Alice"));
		facts.recordTaskLauncher(launched, testDir, named("Alice"));
		specDir(testDir, "002-b");
		specDir(testDir, "003-c");
		writeLedger(path.join(testDir, ".workpilot"), [usage("001-a")]);

		const [a, b, c] = facts.attachRunFacts(
			testDir,
			[
				task("001-a"),
				task("002-b", {
					statusHistory: [
						{ from: null, to: "backlog", at: "2026-11-27T09:00:00Z", actor: "user" },
						{ from: "backlog", to: "in_progress", at: "2026-11-27T09:01:00Z", actor: "user" },
					],
				}),
				task("003-c", {
					metadata: { automation: { ruleId: "r", ruleName: "Nightly" } } as Task["metadata"],
				}),
			],
			{ local: true, specDirOf: specs(testDir), identity: named("Léa") },
		);
		expect(a.runFacts?.createdBy?.name).toBe("Alice");
		expect(a.runFacts?.startedBy?.name).toBe("Alice");
		expect(a.runFacts?.usage?.sessions).toBe(1);
		// Not noted: this computer's person, launcher only once it ran.
		expect(b.runFacts).toEqual({
			createdBy: { kind: "person", name: "Léa" },
			startedBy: { kind: "person", name: "Léa" },
		});
		expect(c.runFacts).toEqual({ createdBy: { kind: "automation" } });
	});

	it("takes a server card's facts from its snapshot only", () => {
		const dir = specDir(testDir, "001-a");
		writeFileSync(
			path.join(dir, facts.PEOPLE_FILE),
			JSON.stringify({ version: 1, createdBy: { kind: "person", name: "Alice" } }),
			"utf-8",
		);
		writeFileSync(
			path.join(dir, facts.USAGE_SUMMARY_FILE),
			JSON.stringify({ inputTokens: 5, sessions: 1, models: [] }),
			"utf-8",
		);
		specDir(testDir, "002-b");
		// A ledger in the mirror is never the server's word.
		writeLedger(path.join(testDir, ".workpilot"), [usage("002-b")]);

		const [a, b] = facts.attachRunFacts(testDir, [task("001-a"), task("002-b")], {
			local: false,
			specDirOf: specs(testDir),
			identity: named("Léa"),
		});
		expect(a.runFacts?.createdBy).toEqual({ kind: "person", name: "Alice" });
		expect(a.runFacts?.startedBy).toBeUndefined();
		expect(a.runFacts?.usage?.inputTokens).toBe(5);
		expect(b.runFacts).toBeUndefined();
		expect(facts.attachRunFacts(testDir, [], { local: true, specDirOf: specs(testDir) })).toEqual([]);
	});

	it("are on the tasks the project store loads, and in the server's snapshot", async () => {
		mkdirSync(path.join(testDir, "userData", "store"), { recursive: true });
		vi.resetModules();
		const project = path.join(testDir, "project");
		const dir = specDir(project, "001-a");
		writeFileSync(
			path.join(dir, "implementation_plan.json"),
			JSON.stringify({ feature: "A", status: "done", phases: [] }),
			"utf-8",
		);
		writeFileSync(path.join(dir, "spec.md"), "# A\n", "utf-8");
		const again = await import("../task-run-facts");
		again.recordTaskCreator(dir, project, "person", named("Alice"));
		writeLedger(path.join(project, ".workpilot"), [usage("001-a")]);

		const { ProjectStore } = await import("../project-store");
		const store = new ProjectStore();
		const { id } = store.addProject(project);
		const [loaded] = store.getTasks(id);
		expect(loaded.runFacts?.createdBy?.name).toBe("Alice");
		expect(loaded.runFacts?.usage?.costUsd).toBe(0.25);

		const { parseSnapshot } = await import("../remote-board");
		const people = JSON.stringify({ version: 1 });
		const parsed = parseSnapshot({
			cards: {
				"001-a": {
					"task_people.json": people,
					"usage_summary.json": "{}",
					"agent.log": "no",
				},
			},
		});
		expect(parsed?.cards["001-a"]).toEqual({
			"task_people.json": people,
			"usage_summary.json": "{}",
		});
	});
});
