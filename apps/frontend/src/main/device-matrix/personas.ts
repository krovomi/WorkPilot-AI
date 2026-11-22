/**
 * Les personas de la matrice d'appareils (#383) : un jeu de cookies nommé,
 * enregistré depuis la session de l'aperçu et rejoué à la demande dans la
 * session d'une capture (« connecté en admin », « client sans commande »).
 *
 * Ce sont des identifiants. Ils ne passent jamais par le renderer : il donne
 * un nom, le main lit lui-même les cookies que l'aperçu envoie au serveur de
 * l'émulateur, les chiffre par le trousseau de l'OS (`secret-storage.ts`,
 * forme `enc:`) et écrit `<userData>/device-matrix/personas.json` (0600). Sans
 * trousseau, l'enregistrement est refusé (`encryption-unavailable`) : jamais
 * de cookie en clair sur le disque. Le renderer ne reçoit que le nom, l'hôte,
 * le nombre de cookies et la date.
 *
 * Un persona n'est rejoué que sur l'hôte où il a été enregistré (schéma et
 * nom d'hôte ; un cookie ignore le port, un serveur de dev en change) :
 * ailleurs, `persona-elsewhere`. Un chiffré que le trousseau ne rend pas
 * (verrouillé, autre machine) est `persona-locked`, jamais une capture
 * déconnectée présentée comme connectée.
 */
import { randomUUID } from "node:crypto";
import type { PersonaError, PersonaSummary } from "../../shared/types/device-library";
import { MAX_PERSONAS, PERSONA_ID, readDisplayName } from "../../shared/utils/custom-device";
import {
	decryptSecret,
	encryptSecret,
	getSecureStorageStatus,
	isEncryptedSecret,
	prepareSecrets,
	primeSecretFiles,
} from "../secret-storage";
import { libraryPath, readLibrary, writeLibrary } from "./library-file";
import { type CookieCopy, MAX_SHARED_COOKIES, readPreviewCookies } from "./preview-session";

export type PersonaFailureCode = PersonaError | "persona-locked" | "persona-elsewhere";

export class PersonaFailure extends Error {
	constructor(readonly code: PersonaFailureCode) {
		super(code);
	}
}

interface StoredPersona extends PersonaSummary {
	/** Les cookies, en JSON chiffré (`enc:…`). */
	readonly cookies: string;
}

/** Un cookie fait au plus 4 096 octets, nom et valeur compris. */
const MAX_COOKIE_PART = 4096;
const SAME_SITE: readonly CookieCopy["sameSite"][] = ["unspecified", "no_restriction", "lax", "strict"];
const HOST = /^https?:\/\/[^/\s]{1,253}$/;

/** `schéma://hôte` d'une origine : ce qui décide où un cookie part. */
export function hostOf(origin: string): string {
	const url = new URL(origin);
	return `${url.protocol}//${url.hostname}`;
}

function readStoredPersona(raw: unknown): StoredPersona | null {
	if (!raw || typeof raw !== "object") return null;
	const { id, name, host, cookieCount, savedAt, cookies } = raw as Record<string, unknown>;
	const shownName = readDisplayName(name);
	if (typeof id !== "string" || !PERSONA_ID.test(id) || shownName === null) return null;
	if (typeof host !== "string" || !HOST.test(host) || !isEncryptedSecret(cookies)) return null;
	if (typeof cookieCount !== "number" || !Number.isInteger(cookieCount)) return null;
	if (cookieCount < 1 || cookieCount > MAX_SHARED_COOKIES) return null;
	if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
	return { id, name: shownName, host, cookieCount, savedAt, cookies };
}

const summary = ({ id, name, host, cookieCount, savedAt }: StoredPersona): PersonaSummary => ({
	id,
	name,
	host,
	cookieCount,
	savedAt,
});

const part = (value: unknown, min = 0): value is string =>
	typeof value === "string" && value.length >= min && value.length <= MAX_COOKIE_PART;

/** Un cookie déchiffré, relu comme une donnée : `null` s'il sort de sa forme. */
export function readCookie(raw: unknown): CookieCopy | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as Record<string, unknown>;
	if (!part(c.name, 1) || !part(c.value) || !part(c.path, 1)) return null;
	if (c.domain !== undefined && !part(c.domain)) return null;
	if (c.expirationDate !== undefined && (typeof c.expirationDate !== "number" || !Number.isFinite(c.expirationDate))) {
		return null;
	}
	const flags = [c.hostOnly, c.secure, c.httpOnly, c.session];
	if (!flags.every((flag) => typeof flag === "boolean")) return null;
	const sameSite = SAME_SITE.find((known) => known === c.sameSite);
	if (!sameSite) return null;
	return {
		name: c.name,
		value: c.value,
		domain: c.domain as string | undefined,
		hostOnly: c.hostOnly as boolean,
		path: c.path,
		secure: c.secure as boolean,
		httpOnly: c.httpOnly as boolean,
		session: c.session as boolean,
		expirationDate: c.expirationDate as number | undefined,
		sameSite,
	};
}

let queue: Promise<unknown> = Promise.resolve();

const stored = () => readLibrary("personas", readStoredPersona, MAX_PERSONAS);

export async function listPersonas(): Promise<PersonaSummary[]> {
	return (await stored()).map(summary);
}

function change(update: (personas: StoredPersona[]) => Promise<StoredPersona[]>): Promise<PersonaSummary[]> {
	const next = queue.then(async () => {
		const personas = await update(await stored());
		try {
			await writeLibrary("personas", personas);
		} catch {
			throw new PersonaFailure("write-failed");
		}
		return personas.map(summary);
	});
	queue = next.catch(() => undefined);
	return next;
}

/**
 * Enregistre sous `name` (déjà relu) les cookies que l'aperçu envoie à
 * `origin`, chiffrés. Refuse sans trousseau, sans cookie, ou la liste pleine.
 */
export function savePersona(name: string, origin: string): Promise<PersonaSummary[]> {
	return change(async (personas) => {
		if (personas.length >= MAX_PERSONAS) throw new PersonaFailure("too-many");
		if (!getSecureStorageStatus().keyringAvailable) throw new PersonaFailure("encryption-unavailable");
		let read: CookieCopy[];
		try {
			read = await readPreviewCookies(origin);
		} catch {
			throw new PersonaFailure("session-failed");
		}
		const cookies = read.map(readCookie).filter((cookie): cookie is CookieCopy => cookie !== null);
		if (cookies.length === 0) throw new PersonaFailure("no-cookies");
		const plain = JSON.stringify(cookies);
		await prepareSecrets([plain]);
		const sealed = encryptSecret(plain);
		// Un trousseau qui n'a pas chiffré : rien n'est écrit, plutôt qu'un cookie en clair.
		if (!isEncryptedSecret(sealed)) throw new PersonaFailure("encryption-unavailable");
		const persona: StoredPersona = {
			id: `persona-${randomUUID()}`,
			name,
			host: hostOf(origin),
			cookieCount: cookies.length,
			savedAt: Date.now(),
			cookies: sealed,
		};
		return [...personas, persona];
	});
}

export function deletePersona(id: string): Promise<PersonaSummary[]> {
	return change(async (personas) => {
		if (!personas.some((persona) => persona.id === id)) throw new PersonaFailure("unknown-persona");
		return personas.filter((persona) => persona.id !== id);
	});
}

/** Les cookies du persona `id`, déchiffrés, pour une capture de `origin`. */
export async function personaCookies(id: string, origin: string): Promise<CookieCopy[]> {
	const persona = (await stored()).find((entry) => entry.id === id);
	if (!persona) throw new PersonaFailure("unknown-persona");
	if (persona.host !== hostOf(origin)) throw new PersonaFailure("persona-elsewhere");
	await primeSecretFiles([libraryPath("personas")]);
	const plain = decryptSecret(persona.cookies);
	if (plain === undefined) throw new PersonaFailure("persona-locked");
	let parsed: unknown;
	try {
		parsed = JSON.parse(plain);
	} catch {
		throw new PersonaFailure("persona-locked");
	}
	if (!Array.isArray(parsed)) throw new PersonaFailure("persona-locked");
	return parsed
		.slice(0, MAX_SHARED_COOKIES)
		.map(readCookie)
		.filter((cookie): cookie is CookieCopy => cookie !== null);
}
