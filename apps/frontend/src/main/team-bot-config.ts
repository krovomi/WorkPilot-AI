/**
 * The Team Bot configuration (Slack / Microsoft Teams incoming webhook), kept
 * by the main process in `<userData>/team-bot.json` (F175).
 *
 * An incoming webhook URL is a credential: whoever holds it posts into the
 * channel. It used to live in the renderer's localStorage, in clear, and went
 * to the runner on its command line. Now it is encrypted at rest like every
 * other secret (secret-storage.ts), the renderer only ever sees MASKED_SECRET
 * (rule S6), and the runner reads it from its stdin.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { TeamBotConfig, TeamBotKind } from "../shared/types/team-bot";
import { decryptSecret, encryptSecret, prepareSecrets } from "./secret-storage";
import { restrictToOwner } from "./settings-utils";
import { maskSecret, unmaskSecret } from "./utils/masked-secret";

const FILE_NAME = "team-bot.json";
const KINDS: readonly TeamBotKind[] = ["slack", "teams"];
const MAX_URL = 2048;
const MAX_CHANNEL = 200;
const MAX_TAGS = 20;
const MAX_TAG = 64;

export const DEFAULT_TEAM_BOT_CONFIG: TeamBotConfig = {
	kind: "slack",
	webhook_url: "",
	enabled: false,
	tags: [],
};

/** Raised for a configuration the renderer sent that cannot be stored. */
export class TeamBotConfigError extends Error {}

export function teamBotConfigPath(): string {
	return path.join(app.getPath("userData"), FILE_NAME);
}

/** What is on disk, the URL still as stored (`enc:` or legacy clear text). */
function readStored(): TeamBotConfig {
	const file = teamBotConfigPath();
	if (!existsSync(file)) return { ...DEFAULT_TEAM_BOT_CONFIG };
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
		return { ...DEFAULT_TEAM_BOT_CONFIG, ...sanitize(parsed) };
	} catch {
		return { ...DEFAULT_TEAM_BOT_CONFIG };
	}
}

/**
 * The configuration with its webhook URL in clear, for the runner only.
 * The URL is empty when it cannot be decrypted right now (keyring locked).
 */
export function readTeamBotConfig(): TeamBotConfig {
	const stored = readStored();
	return { ...stored, webhook_url: decryptSecret(stored.webhook_url) ?? "" };
}

/** The configuration as the renderer may see it: the URL masked when set. */
export function maskedTeamBotConfig(): TeamBotConfig {
	const stored = readStored();
	return { ...stored, webhook_url: maskSecret(stored.webhook_url) };
}

/**
 * Store what the settings screen sent. A masked URL coming back keeps the
 * stored one; the text typed around the mask replaces it.
 */
export async function saveTeamBotConfig(update: unknown): Promise<TeamBotConfig> {
	const next = sanitize(update);
	const stored = readStored();
	const typed = unmaskSecret(next.webhook_url)?.trim();
	if (typed && !/^https?:\/\//i.test(typed)) {
		throw new TeamBotConfigError("The webhook URL must start with https://");
	}
	const url = typed === undefined ? stored.webhook_url : typed;
	await prepareSecrets([url]);
	const toWrite: TeamBotConfig = { ...stored, ...next, webhook_url: encryptSecret(url) };
	const file = teamBotConfigPath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(toWrite, null, 2), { encoding: "utf-8", mode: 0o600 });
	restrictToOwner(file);
	return maskedTeamBotConfig();
}

/** Only the known fields, each of the expected type and size (rule S6). */
function sanitize(value: unknown): TeamBotConfig {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const kind = KINDS.includes(record.kind as TeamBotKind)
		? (record.kind as TeamBotKind)
		: DEFAULT_TEAM_BOT_CONFIG.kind;
	const url = typeof record.webhook_url === "string" ? record.webhook_url : "";
	if (url.length > MAX_URL) throw new TeamBotConfigError("The webhook URL is too long");
	const result: TeamBotConfig = {
		kind,
		webhook_url: url,
		enabled: record.enabled === true,
		tags: Array.isArray(record.tags)
			? record.tags
					.filter((tag): tag is string => typeof tag === "string")
					.slice(0, MAX_TAGS)
					.map((tag) => tag.slice(0, MAX_TAG))
			: [],
	};
	if (typeof record.default_channel === "string" && record.default_channel) {
		result.default_channel = record.default_channel.slice(0, MAX_CHANNEL);
	}
	return result;
}
