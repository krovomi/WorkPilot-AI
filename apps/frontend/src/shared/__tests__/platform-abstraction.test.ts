/**
 * « Ne jamais utiliser `process.platform` directement » est une règle critique de
 * `docs/CLAUDE.md` : le dépôt supporte Windows, macOS et Linux, et la CI teste
 * les trois. Elle était enfreinte 57 fois, dans 17 fichiers, alors que les deux
 * abstractions existent depuis toujours :
 *
 *   - `src/main/platform/index.ts` — `isWindows()`, `isMacOS()`, `isLinux()`,
 *     `isUnix()`, `getCurrentOS()`, plus la résolution d'exécutables et de
 *     chemins ;
 *   - `src/shared/platform.ts` — les mêmes prédicats, moquables en test parce
 *     qu'ils passent tous par `getCurrentPlatform()`.
 *
 * Une règle qu'aucun test ne défend redevient une suggestion : celle-ci avait
 * dérivé jusqu'à peser plus que les deux modules qu'elle prescrit.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");

/** Les modules d'abstraction eux-mêmes : ils *doivent* lire `process.platform`. */
const ABSTRACTION = ["main/platform", "shared/platform.ts"];

/**
 * Lectures qui restent légitimes, avec leur raison.
 *
 * Toutes rapportent la plateforme *brute* à un humain — un log, un message
 * d'erreur — ou servent de valeur par défaut à une fonction pure qu'un test
 * appelle avec une autre plateforme. Les faire passer par `getCurrentOS()`
 * serait un contresens : il replie FreeBSD et consorts sur Linux, ce qui est
 * exactement ce qu'un diagnostic ne doit pas faire.
 */
const ALLOWED = new Map<string, string>([
	[
		"shared/utils/powershell-color-support.ts:52",
		"objet de diagnostic : rapporte la plateforme brute",
	],
	[
		"main/ipc-handlers/settings-handlers.ts:380",
		"console.warn de diagnostic",
	],
	[
		"main/services/ollama-portable.ts:59",
		"valeur par défaut d'une fonction pure, testée avec d'autres plateformes",
	],
	[
		"main/services/ollama-portable.ts:333",
		"message d'erreur : nomme la plateforme réellement rencontrée",
	],
	["main/app-logger.ts:165", "métadonnée de log"],
	[
		"main/claude-profile/credential-utils.ts:1533",
		"message « Unsupported platform » : la plateforme brute est l'information",
	],
	[
		"main/claude-profile/credential-utils.ts:2139",
		"message « Unsupported platform » : la plateforme brute est l'information",
	],
	[
		"main/claude-profile/credential-utils.ts:2869",
		"message « Unsupported platform » : la plateforme brute est l'information",
	],
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			sourceFiles(full, out);
		} else if (
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
			!entry.name.includes(".test.")
		) {
			out.push(full);
		}
	}
	return out;
}

describe("abstraction de plateforme", () => {
	const hits: { location: string; line: string }[] = [];

	for (const file of sourceFiles(SRC)) {
		const rel = path.relative(SRC, file).replace(/\\/g, "/");
		if (ABSTRACTION.some((a) => rel.startsWith(a))) continue;

		const lines = readFileSync(file, "utf-8").split("\n");
		lines.forEach((line, i) => {
			if (line.includes("process.platform")) {
				hits.push({ location: `${rel}:${i + 1}`, line: line.trim() });
			}
		});
	}

	it("balaie bien les sources", () => {
		expect(sourceFiles(SRC).length).toBeGreaterThan(500);
	});

	it("passe par main/platform ou shared/platform, hors exceptions listées", () => {
		const offenders = hits
			.filter((h) => !ALLOWED.has(h.location))
			.map((h) => `${h.location}: ${h.line}`);

		expect(offenders).toEqual([]);
	});

	it("n'autorise aucune exception devenue caduque", () => {
		// Une entrée d'`ALLOWED` qui ne correspond plus à rien signifie que le
		// code a bougé : la liste doit rétrécir avec lui, pas rester en place.
		const seen = new Set(hits.map((h) => h.location));
		const stale = [...ALLOWED.keys()].filter((k) => !seen.has(k));

		expect(stale).toEqual([]);
	});
});
