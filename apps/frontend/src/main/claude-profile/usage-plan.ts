/**
 * The plan of the account the usage panel shows ("Claude Max 20x", "ChatGPT
 * Plus", "Copilot Pro", an API key billed per use…).
 *
 * Added to each snapshot on its way to the renderer (`terminal-handlers.ts`),
 * after the usage monitor has measured it: the monitor stays as it is, and a
 * plan is looked up once per account, then kept for a few minutes.
 *
 * | Provider | Subscription: where the plan name comes from | API key |
 * |---|---|---|
 * | Anthropic | `subscriptionType` + `rateLimitTier` Claude Code stores with its OAuth login (profile, else credentials store) | API profile or `globalAnthropicApiKey` |
 * | OpenAI | `plan_type` ChatGPT / Codex CLI report (`openaiSubscription.planType`) | API profile or `globalOpenAIApiKey` |
 * | Copilot | `copilot_plan` + `access_type_sku` of `/copilot_internal/user` | — |
 * | Windsurf | `planName` the IDE caches in its state database | — |
 * | Cursor | `cursorAuth/stripeMembershipType` in its state database | — |
 * | Gemini CLI | Google login: plan not reported, billing mode only | `gemini-api-key` / `vertex-ai` |
 * | Others (Mistral, Google, DeepSeek, Grok…) | — | API profile or global key |
 *
 * Nothing is sent anywhere: every source is local, or already fetched by the
 * monitor. When a provider does not say, the plan has no name; nothing is
 * guessed. No credential is ever logged or returned, only plan identifiers.
 */

import { existsSync, promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AllProfilesUsage,
	ProfileUsageSummary,
	UsagePlan,
	UsageSnapshot,
} from "@shared/types";
import {
	chatgptPlanName,
	claudePlanName,
	copilotPlanName,
	cursorPlanName,
	windsurfPlanName,
} from "../../shared/utils/plan-names";
import { detectProvider } from "../../shared/utils/provider-detection";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { isMacOS, isWindows } from "../platform";
import { readWindsurfCachedPlanInfo } from "../services/credential-manager";
import { loadProfilesFile } from "../services/profile";
import { loadBetterSqlite } from "../services/windsurf-sqlite";
import { readSettingsFile } from "../settings-utils";
import { getFullCredentialsFromKeychain } from "./credential-utils";

/** A plan changes rarely; reading it once per account every 5 minutes is enough. */
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

const planCache = new Map<
	string,
	{ plan: UsagePlan | undefined; at: number }
>();

/** Forget every cached plan (tests, or after a login). */
export function resetUsagePlanCache(): void {
	planCache.clear();
}

/** The settings key that holds a provider's global API key. */
const GLOBAL_API_KEY_SETTING: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["globalAnthropicApiKey"],
	openai: ["globalOpenAIApiKey"],
	google: ["globalGoogleApiKey", "globalGoogleDeepMindApiKey"],
	mistral: ["globalMistralApiKey"],
	deepseek: ["globalDeepSeekApiKey"],
	grok: ["globalGrokApiKey"],
	meta: ["globalMetaApiKey", "globalMetaLlamaApiKey"],
	aws: ["globalAWSApiKey"],
};

const API: UsagePlan = { billing: "api" };

function subscription(name: string | undefined): UsagePlan {
	return name ? { billing: "subscription", name } : { billing: "subscription" };
}

/** Whether a non-empty value is set; the value itself is never read further. */
function isSet(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Billed per use through an API key: the snapshot belongs to an API profile,
 * or (nothing measured) the provider has an API profile or a global key.
 */
async function isApiKeyAccount(
	snapshot: UsageSnapshot,
	provider: string,
): Promise<boolean> {
	try {
		const { profiles } = await loadProfilesFile();
		if (profiles.some((p) => p.id === snapshot.profileId)) return true;
		if (
			profiles.some(
				(p) => isSet(p.apiKey) && detectProvider(p.baseUrl) === provider,
			)
		) {
			return true;
		}
	} catch {
		// no profiles file: decide from the settings
	}
	const keys = GLOBAL_API_KEY_SETTING[provider];
	if (!keys) return false;
	try {
		const settings = readSettingsFile() as Record<string, unknown> | undefined;
		return keys.some((key) => isSet(settings?.[key]));
	} catch {
		return false;
	}
}

/** Claude subscription of an OAuth profile, from what Claude Code stored at login. */
function claudeProfilePlan(profileId: string): UsagePlan | undefined {
	let profile: ReturnType<
		ReturnType<typeof getClaudeProfileManager>["getProfile"]
	>;
	try {
		profile = getClaudeProfileManager().getProfile(profileId);
	} catch {
		return undefined;
	}
	if (!profile) return undefined;
	let { subscriptionType, rateLimitTier } = profile;
	if (!subscriptionType) {
		try {
			const credentials = getFullCredentialsFromKeychain(profile.configDir);
			subscriptionType = credentials.subscriptionType ?? undefined;
			rateLimitTier = credentials.rateLimitTier ?? rateLimitTier;
		} catch {
			// credentials store unreadable: the plan stays unnamed
		}
	}
	return subscription(claudePlanName(subscriptionType, rateLimitTier));
}

function cursorStateDbPath(): string {
	const tail = ["Cursor", "User", "globalStorage", "state.vscdb"];
	if (isWindows()) return join(process.env.APPDATA || "", ...tail);
	if (isMacOS()) {
		return join(homedir(), "Library", "Application Support", ...tail);
	}
	return join(homedir(), ".config", ...tail);
}

/** Cursor's membership, as its IDE stores it; undefined when Cursor is not signed in here. */
export function readCursorMembership(
	dbPath: string = cursorStateDbPath(),
): string | undefined {
	if (!existsSync(dbPath)) return undefined;
	let db: import("better-sqlite3").Database | undefined;
	try {
		const Database = loadBetterSqlite();
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
		const row = db
			.prepare("SELECT value FROM ItemTable WHERE key = ?")
			.get("cursorAuth/stripeMembershipType") as
			| { value: string | Buffer }
			| undefined;
		if (!row) return undefined;
		const value = Buffer.isBuffer(row.value)
			? row.value.toString("utf-8")
			: row.value;
		// Stored as a bare word or as a JSON string ("\"pro\"").
		const unquoted = typeof value === "string" ? value.replace(/^"|"$/g, "") : "";
		return /^[A-Za-z0-9_-]{1,40}$/.test(unquoted) ? unquoted : undefined;
	} catch {
		return undefined;
	} finally {
		db?.close();
	}
}

/** How Gemini CLI signs in: a Google account, an API key or Vertex AI. */
export async function readGeminiCliAuthType(
	settingsPath: string = join(homedir(), ".gemini", "settings.json"),
): Promise<string | undefined> {
	try {
		const raw = await fsp.readFile(settingsPath, "utf-8");
		if (raw.length > 1_000_000) return undefined;
		const settings = JSON.parse(raw) as {
			selectedAuthType?: unknown;
			security?: { auth?: { selectedType?: unknown } };
		};
		const type = settings.security?.auth?.selectedType ?? settings.selectedAuthType;
		return typeof type === "string" ? type : undefined;
	} catch {
		return undefined;
	}
}

async function resolvePlan(
	snapshot: UsageSnapshot,
): Promise<UsagePlan | undefined> {
	const provider =
		snapshot.providerName === "claude"
			? "anthropic"
			: (snapshot.providerName ?? "anthropic");

	switch (provider) {
		case "anthropic": {
			const oauth = claudeProfilePlan(snapshot.profileId);
			if (oauth) return oauth;
			return (await isApiKeyAccount(snapshot, provider)) ? API : undefined;
		}
		case "openai": {
			if (snapshot.openaiSubscription) {
				return subscription(
					chatgptPlanName(snapshot.openaiSubscription.planType),
				);
			}
			if (snapshot.openaiUsageDetails) return API;
			return (await isApiKeyAccount(snapshot, provider)) ? API : undefined;
		}
		case "copilot": {
			const details = snapshot.copilotUsageDetails;
			return subscription(copilotPlanName(details?.plan, details?.sku));
		}
		case "windsurf": {
			const cached = await readWindsurfCachedPlanInfo();
			return subscription(
				cached.success ? windsurfPlanName(cached.planInfo?.planName) : undefined,
			);
		}
		case "cursor": {
			const name = cursorPlanName(readCursorMembership());
			if (name) return subscription(name);
			return (await isApiKeyAccount(snapshot, provider)) ? API : undefined;
		}
		case "gemini-cli": {
			const auth = await readGeminiCliAuthType();
			if (auth === "oauth-personal") return subscription(undefined);
			if (auth === "gemini-api-key" || auth === "vertex-ai") return API;
			return undefined;
		}
		case "ollama_local":
			// A local model is neither a plan nor billed.
			return undefined;
		default:
			return (await isApiKeyAccount(snapshot, provider)) ? API : undefined;
	}
}

async function cachedPlan(
	key: string,
	resolve: () => Promise<UsagePlan | undefined> | UsagePlan | undefined,
): Promise<UsagePlan | undefined> {
	const hit = planCache.get(key);
	if (hit && Date.now() - hit.at < PLAN_CACHE_TTL_MS) return hit.plan;
	let plan: UsagePlan | undefined;
	try {
		plan = await resolve();
	} catch {
		plan = undefined;
	}
	planCache.set(key, { plan, at: Date.now() });
	return plan;
}

/** The snapshot with its account's plan, when one is known. */
export async function withUsagePlan<T extends UsageSnapshot | null | undefined>(
	snapshot: T,
): Promise<T> {
	if (!snapshot || snapshot.plan) return snapshot;
	// The ChatGPT plan and Copilot's come with the snapshot: never cached.
	const fromSnapshot =
		snapshot.openaiSubscription || snapshot.providerName === "copilot";
	const plan = fromSnapshot
		? await resolvePlan(snapshot).catch(() => undefined)
		: await cachedPlan(
				`${snapshot.providerName ?? "anthropic"}:${snapshot.profileId}`,
				() => resolvePlan(snapshot),
			);
	return plan ? { ...snapshot, plan } : snapshot;
}

/** Every Claude account of the "other accounts" list, with its plan. */
export async function withProfilesPlans(
	usage: AllProfilesUsage | null | undefined,
): Promise<AllProfilesUsage | null | undefined> {
	if (!usage) return usage;
	const allProfiles = await Promise.all(
		usage.allProfiles.map(async (profile): Promise<ProfileUsageSummary> => {
			if (profile.plan) return profile;
			const plan = await cachedPlan(`anthropic:${profile.profileId}`, () =>
				claudeProfilePlan(profile.profileId),
			);
			return plan ? { ...profile, plan } : profile;
		}),
	);
	return {
		...usage,
		activeProfile: await withUsagePlan(usage.activeProfile),
		allProfiles,
	};
}
