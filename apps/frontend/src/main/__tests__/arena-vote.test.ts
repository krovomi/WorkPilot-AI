/**
 * A failed contestant cannot win an Arena battle.
 *
 * Copilot answered a battle with "Copilot auth error: … (403)", the Arena
 * showed it as Copilot's answer, and offered to vote for it. The renderer now
 * hides the vote on a failed card; the handler refuses such a vote too, so the
 * rankings can never count an error message as a win.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

const participant = (
	label: "A" | "B",
	status: "completed" | "error",
	model: string,
) => ({
	label,
	contenderId: `copilot:${model}`,
	provider: "copilot",
	providerLabel: "GitHub Copilot",
	model,
	modelName: model,
	status,
	output: status === "completed" ? "Hello!" : "",
	tokensUsed: 0,
	usageEstimated: true,
	durationMs: 1000,
	...(status === "error" ? { error: "Copilot auth error: (403)" } : {}),
});

const BATTLE = {
	id: "arena-1",
	taskType: "coding",
	prompt: "say hello",
	status: "voting",
	revealed: false,
	createdAt: 1,
	participants: [
		participant("A", "completed", "gpt-4o"),
		participant("B", "error", "claude-sonnet-4.5"),
	],
};

const arenaDir = () => path.join(USER_DATA_PATH, "arena-mode");
const battlesPath = () => path.join(arenaDir(), "battles.json");
const votesPath = () => path.join(arenaDir(), "votes.json");

async function vote(winnerLabel: "A" | "B") {
	const handler = handlers.get("arena:vote");
	if (!handler) throw new Error("arena:vote was never registered");
	return (await handler(
		{},
		{
			battleId: BATTLE.id,
			taskType: "coding",
			winnerLabel,
			winnerContenderId: BATTLE.participants.find((p) => p.label === winnerLabel)
				?.contenderId,
			votedAt: 2,
		},
	)) as { success: boolean; error?: string };
}

describe("Arena vote", () => {
	beforeEach(async () => {
		TEST_DIR = mkdtempSync(path.join(tmpdir(), "arena-vote-test-"));
		USER_DATA_PATH = path.join(TEST_DIR, "userData");
		mkdirSync(arenaDir(), { recursive: true });
		writeFileSync(battlesPath(), JSON.stringify([BATTLE]), "utf-8");
		handlers.clear();
		vi.resetModules();
		const { registerArenaHandlers } = await import(
			"../ipc-handlers/arena-handlers"
		);
		registerArenaHandlers(() => null);
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("refuses a vote for a model that failed, and records nothing", async () => {
		const result = await vote("B");

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/failed/);
		const [battle] = JSON.parse(readFileSync(battlesPath(), "utf-8"));
		expect(battle.status).toBe("voting");
		expect(battle.winnerLabel).toBeUndefined();
		expect(existsSync(votesPath())).toBe(false);
	});

	it("records a vote for a model that answered", async () => {
		const result = await vote("A");

		expect(result.success).toBe(true);
		const [battle] = JSON.parse(readFileSync(battlesPath(), "utf-8"));
		expect(battle.status).toBe("completed");
		expect(battle.winnerLabel).toBe("A");
		expect(JSON.parse(readFileSync(votesPath(), "utf-8"))).toHaveLength(1);
	});
});
