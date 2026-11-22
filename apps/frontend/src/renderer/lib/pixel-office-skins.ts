/**
 * Pixel Office's cosmetics (#350): how the characters are dressed, and which
 * earned decor the office shows.
 *
 * - `provider` (the default): each character wears its provider family's
 *   shirt (`FAMILY_SHIRTS`), so a glance tells who runs what.
 * - `classic`: every character keeps its own colours.
 * - `neon`: a reward. It is worn once every season goal has been met at
 *   least once, that is once every piece of decor is earned; until then the
 *   office dresses its characters as `provider`. Its pink is no family's.
 *
 * Decor is earned by the seasons (`pixel-office-seasons.ts`); a person may
 * hide a piece they do not want to see. Both choices are view preferences of
 * this computer, kept with the office's other settings.
 */

import type { ProviderFamily } from "../../shared/types/pixel-office";
import { FAMILY_SHIRTS } from "./pixel-office-providers";
import { DECOR_IDS, type DecorId } from "./pixel-office-seasons";

export const AGENT_SKINS = ["provider", "classic", "neon"] as const;
export type AgentSkin = (typeof AGENT_SKINS)[number];

export const NEON_SHIRT = "#FF2E97";

const SKINS = new Set<string>(AGENT_SKINS);

/** Whether `skin` may be worn, given the decor earned so far. */
export function skinUnlocked(skin: AgentSkin, earned: readonly DecorId[]): boolean {
	return skin !== "neon" || DECOR_IDS.every((id) => earned.includes(id));
}

/** The skin the characters wear: the one chosen, or `provider` while it is locked. */
export function wornSkin(chosen: AgentSkin, earned: readonly DecorId[]): AgentSkin {
	return skinUnlocked(chosen, earned) ? chosen : "provider";
}

/** The shirt colour of a character, or undefined for its own colours. */
export function agentShirt(
	family: ProviderFamily | undefined,
	skin: AgentSkin,
): string | undefined {
	if (skin === "neon") return NEON_SHIRT;
	if (skin === "classic" || !family) return undefined;
	return FAMILY_SHIRTS[family];
}

/** The earned decor the office draws: all of it but what the person hid. */
export function shownDecor(
	earned: readonly DecorId[],
	hidden: readonly DecorId[],
): DecorId[] {
	return earned.filter((id) => !hidden.includes(id));
}

/** A saved skin, read back: a known one, else the default. */
export function savedSkin(value: unknown): AgentSkin {
	return typeof value === "string" && SKINS.has(value) ? (value as AgentSkin) : "provider";
}

/** Saved hidden decor, read back: known ids only, each once. */
export function savedHiddenDecor(value: unknown): DecorId[] {
	if (!Array.isArray(value)) return [];
	return DECOR_IDS.filter((id) => value.includes(id));
}
