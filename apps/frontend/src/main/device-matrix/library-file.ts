/**
 * Les fichiers de la matrice d'appareils (#383) sous le dossier de l'app :
 * `<userData>/device-matrix/<nom>.json`, un objet `{ entries: [...] }`.
 *
 * Le nom est une constante du main, jamais reçue. Ce qui est relu est une
 * donnée : chaque entrée repasse par le lecteur de l'appelant, qui écarte ce
 * qui sort de ses bornes (un fichier modifié à la main ne fait pas émuler
 * n'importe quoi). L'écriture passe par un fichier temporaire renommé, pour
 * qu'un arrêt en route ne laisse pas un fichier coupé, et donne un fichier
 * lisible par son seul propriétaire.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

export type LibraryName = "custom-devices" | "personas";

export function libraryPath(name: LibraryName): string {
	return path.join(app.getPath("userData"), "device-matrix", `${name}.json`);
}

/** Les entrées relues, au plus `max`, celles que `read` refuse écartées ; `[]` si le fichier manque ou ne se lit pas. */
export async function readLibrary<T>(name: LibraryName, read: (raw: unknown) => T | null, max: number): Promise<T[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(libraryPath(name), "utf-8"));
	} catch {
		return [];
	}
	const entries = parsed && typeof parsed === "object" ? (parsed as { entries?: unknown }).entries : undefined;
	if (!Array.isArray(entries)) return [];
	return entries
		.slice(0, max)
		.map(read)
		.filter((entry): entry is T => entry !== null);
}

export async function writeLibrary(name: LibraryName, entries: readonly unknown[]): Promise<void> {
	const file = libraryPath(name);
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify({ entries }, null, 2), { encoding: "utf-8", mode: 0o600 });
	await rename(temporary, file);
}
