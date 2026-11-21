/**
 * Le bridage réseau et processeur de la matrice d'appareils (#383).
 *
 * Partagé entre le renderer, qui propose ces profils, et le main, qui
 * n'applique qu'eux : le renderer nomme un profil par son `id`, il ne donne
 * jamais une latence, un débit ou un facteur. Les valeurs sont celles des
 * profils intégrés aux DevTools de Chromium (« Slow 3G », « 3G »,
 * « Fast 4G », ralentissement ×2 à ×6).
 */
import type { CpuProfile, CpuProfileId, NetworkProfile, NetworkProfileId } from "../types/device-matrix";

/** Sans bridage, comme avant le bridage : le chargement a 30 s. */
export const BASE_LOAD_TIMEOUT_MS = 30_000;
/** Plafond du chargement, réseau lent et processeur ralenti cumulés. */
export const MAX_LOAD_TIMEOUT_MS = 180_000;

export const NETWORK_PROFILES: readonly NetworkProfile[] = [
	{ id: "none", conditions: null, loadTimeoutMs: BASE_LOAD_TIMEOUT_MS },
	{
		id: "4g",
		conditions: { latencyMs: 165, downloadBytesPerSecond: 1_012_500, uploadBytesPerSecond: 168_750 },
		loadTimeoutMs: BASE_LOAD_TIMEOUT_MS,
	},
	{
		id: "fast-3g",
		conditions: { latencyMs: 563, downloadBytesPerSecond: 180_000, uploadBytesPerSecond: 84_375 },
		loadTimeoutMs: 60_000,
	},
	{
		id: "slow-3g",
		conditions: { latencyMs: 2_000, downloadBytesPerSecond: 50_000, uploadBytesPerSecond: 50_000 },
		loadTimeoutMs: 120_000,
	},
];

export const CPU_PROFILES: readonly CpuProfile[] = [
	{ id: "1x", rate: 1 },
	{ id: "2x", rate: 2 },
	{ id: "4x", rate: 4 },
	{ id: "6x", rate: 6 },
];

export const DEFAULT_NETWORK_PROFILE_ID: NetworkProfileId = "none";
export const DEFAULT_CPU_PROFILE_ID: CpuProfileId = "1x";

/** Le profil réseau d'un identifiant reçu, ou `undefined` : un id inconnu n'est jamais appliqué. */
export function findNetworkProfile(id: unknown): NetworkProfile | undefined {
	if (typeof id !== "string") return undefined;
	return NETWORK_PROFILES.find((profile) => profile.id === id);
}

/** Le ralentissement d'un identifiant reçu, ou `undefined`. */
export function findCpuProfile(id: unknown): CpuProfile | undefined {
	if (typeof id !== "string") return undefined;
	return CPU_PROFILES.find((profile) => profile.id === id);
}

/** Le temps laissé au chargement : celui du réseau, multiplié par le ralentissement, plafonné. */
export function loadTimeoutFor(network: NetworkProfile, cpu: CpuProfile): number {
	return Math.min(MAX_LOAD_TIMEOUT_MS, network.loadTimeoutMs * cpu.rate);
}
