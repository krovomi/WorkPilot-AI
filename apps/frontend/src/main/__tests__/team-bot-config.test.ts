/**
 * @vitest-environment node
 *
 * The Team Bot webhook URL is a credential (F175): the main process keeps it
 * encrypted in <userData>/team-bot.json, the renderer only sees the mask, and
 * a mask sent back keeps the stored URL.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../../shared/constants/secrets";
import { sharedFakeSafeStorage } from "../../__tests__/helpers/fake-safe-storage";

const paths = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => paths.userData },
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

const fake = sharedFakeSafeStorage();
const URL_A = "https://hooks.slack.com/services/T000/B000/secret-a";
const URL_B = "https://hooks.slack.com/services/T000/B000/secret-b";

async function load() {
	vi.resetModules();
	return import("../team-bot-config");
}

function onDisk(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(path.join(paths.userData, "team-bot.json"), "utf-8"),
	);
}

describe("team-bot-config", () => {
	beforeEach(() => {
		fake.reset();
		paths.userData = mkdtempSync(path.join(tmpdir(), "team-bot-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		rmSync(paths.userData, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("stores the webhook URL encrypted and hands the renderer the mask", async () => {
		const config = await load();
		const shown = await config.saveTeamBotConfig({
			kind: "teams",
			webhook_url: URL_A,
			enabled: true,
		});

		expect(shown.webhook_url).toBe(MASKED_SECRET);
		expect(shown.kind).toBe("teams");
		const raw = readFileSync(path.join(paths.userData, "team-bot.json"), "utf-8");
		expect(raw).not.toContain("secret-a");
		expect(String(onDisk().webhook_url)).toMatch(/^enc:/);
		expect(config.maskedTeamBotConfig().webhook_url).toBe(MASKED_SECRET);
		expect(config.readTeamBotConfig().webhook_url).toBe(URL_A);
	});

	it("keeps the stored URL when the mask comes back, replaces it when one is typed", async () => {
		const config = await load();
		await config.saveTeamBotConfig({ kind: "slack", webhook_url: URL_A });

		await config.saveTeamBotConfig({
			kind: "slack",
			webhook_url: MASKED_SECRET,
			enabled: true,
		});
		expect(config.readTeamBotConfig()).toMatchObject({
			webhook_url: URL_A,
			enabled: true,
		});

		await config.saveTeamBotConfig({ kind: "slack", webhook_url: URL_B });
		expect(config.readTeamBotConfig().webhook_url).toBe(URL_B);

		await config.saveTeamBotConfig({ kind: "slack", webhook_url: "" });
		expect(config.readTeamBotConfig().webhook_url).toBe("");
		expect(config.maskedTeamBotConfig().webhook_url).toBe("");
	});

	it("refuses what is not a web URL and drops unknown fields", async () => {
		const config = await load();
		await expect(
			config.saveTeamBotConfig({ kind: "slack", webhook_url: "file:///etc/passwd" }),
		).rejects.toThrow(config.TeamBotConfigError);

		await config.saveTeamBotConfig({
			kind: "irc",
			webhook_url: URL_A,
			tags: ["a", 3, "b"],
			command: "rm -rf /",
		});
		const stored = onDisk();
		expect(stored.kind).toBe("slack");
		expect(stored.tags).toEqual(["a", "b"]);
		expect(stored).not.toHaveProperty("command");
	});

	it("reads an absent or broken file as the default configuration", async () => {
		const config = await load();
		expect(config.maskedTeamBotConfig()).toEqual(config.DEFAULT_TEAM_BOT_CONFIG);
	});
});
