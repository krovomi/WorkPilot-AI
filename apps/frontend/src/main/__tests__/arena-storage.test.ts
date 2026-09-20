/**
 * How the Arena keeps the records of the era it no longer counts.
 *
 * Battles written before the Arena ran real models carry no resolvable model
 * identity, so they cannot answer what the analytics tab asks. They are moved
 * aside rather than deleted — which makes the archive the only copy, and makes
 * "did I overwrite it?" the question worth pinning.
 *
 * CodeQL found the answer was "possibly": the archive was written after an
 * `existsSync` check, and between the two sits a window in which a second
 * window of the app can write it.
 *
 * The outcome tests below cannot tell the two implementations apart — in a
 * single-threaded test nothing ever occupies that window, so a check-then-write
 * preserves the archive exactly as an exclusive create does. They pin the
 * contract, not the fix. What pins the fix is the mechanism: the last test
 * reads the module's own source and asserts the write is exclusive, which is
 * the only property a race cannot be staged to demonstrate.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_PATH: string;
let TEST_DIR: string;

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => USER_DATA_PATH) },
	ipcMain: {
		handle: vi.fn((channel: string, handler: unknown) => {
			handlers.set(channel, handler as Handler);
		}),
	},
}));

vi.mock("../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../oneshot-llm", () => ({ runOneShotLLM: vi.fn(async () => null) }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

/** A battle as the simulated era wrote it: a label, and no identity. */
const LEGACY_BATTLE = {
	id: "arena-legacy",
	taskType: "coding",
	prompt: "anything",
	status: "completed",
	winnerLabel: "A",
	revealed: true,
	createdAt: 1,
	participants: [
		{ label: "A", profileId: "profile-1", modelName: "Model A", provider: "unknown" },
		{ label: "B", profileId: "profile-2", modelName: "Model B", provider: "unknown" },
	],
};

const arenaDir = () => path.join(USER_DATA_PATH, "arena-mode");
const battlesPath = () => path.join(arenaDir(), "battles.json");
const archivePath = () => path.join(arenaDir(), "battles.pre-real-models.json");

async function getBattles(): Promise<{ success: boolean; data?: unknown[] }> {
	const handler = handlers.get("arena:getBattles");
	if (!handler) throw new Error("arena:getBattles was never registered");
	return (await handler({})) as { success: boolean; data?: unknown[] };
}

describe("Arena storage", () => {
	beforeEach(async () => {
		TEST_DIR = mkdtempSync(path.join(tmpdir(), "arena-storage-test-"));
		USER_DATA_PATH = path.join(TEST_DIR, "userData");
		mkdirSync(arenaDir(), { recursive: true });
		handlers.clear();
		vi.resetModules();
		const { registerArenaHandlers } = await import("../ipc-handlers/arena-handlers");
		registerArenaHandlers(() => null);
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("moves a battle with no resolvable identity out of the counted history", async () => {
		writeFileSync(battlesPath(), JSON.stringify([LEGACY_BATTLE]));

		const result = await getBattles();

		expect(result.success).toBe(true);
		expect(result.data).toEqual([]);
		expect(JSON.parse(readFileSync(archivePath(), "utf-8"))).toEqual([
			LEGACY_BATTLE,
		]);
		expect(JSON.parse(readFileSync(battlesPath(), "utf-8"))).toEqual([]);
	});

	it("never overwrites an archive that already exists", async () => {
		// The state the race produced: an archive is already on disk, and a
		// fresh set of legacy records arrives. Preserving the first copy is the
		// whole point of archiving rather than deleting.
		const preserved = [{ id: "written-by-the-other-window" }];
		writeFileSync(archivePath(), JSON.stringify(preserved));
		writeFileSync(battlesPath(), JSON.stringify([LEGACY_BATTLE]));

		await getBattles();

		expect(JSON.parse(readFileSync(archivePath(), "utf-8"))).toEqual(preserved);
		// The live file is still cleared: the records are preserved either way.
		expect(JSON.parse(readFileSync(battlesPath(), "utf-8"))).toEqual([]);
	});

	it("reads an empty history when no file exists yet", async () => {
		const result = await getBattles();

		expect(result.success).toBe(true);
		expect(result.data).toEqual([]);
	});

	it("asks the filesystem for exclusivity rather than asking twice", async () => {
		// The property no outcome can show. `existsSync` followed by a write is
		// two syscalls with a window between them; `wx` is one that fails when
		// the file is already there, so the archive cannot be overwritten by a
		// second window of the app reading the same records at the same moment.
		const source = readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"..",
				"ipc-handlers",
				"arena-handlers.ts",
			),
			"utf-8",
		);

		expect(source).toContain('flag: "wx"');
		expect(source).not.toContain("existsSync(archive)");
	});

	it("keeps a battle whose participants carry a contender id", async () => {
		const modern = {
			...LEGACY_BATTLE,
			id: "arena-modern",
			participants: [
				{
					label: "A",
					contenderId: "anthropic:claude-opus-5",
					provider: "anthropic",
					providerLabel: "Anthropic (Claude)",
					model: "claude-opus-5",
					modelName: "Claude Opus 5",
				},
			],
		};
		writeFileSync(battlesPath(), JSON.stringify([modern]));

		const result = await getBattles();

		expect(result.data).toEqual([modern]);
	});
});
