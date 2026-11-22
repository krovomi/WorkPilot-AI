/**
 * Personas (#383): the preview's cookies for the emulator's origin, saved
 * under a name, encrypted through `secret-storage.ts`, never in clear on disk
 * and never handed to the renderer; replayed only on the host they were saved
 * for, and refused when the keyring cannot give them back.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const folder = vi.hoisted(() => ({ userData: "" }));
const keyring = vi.hoisted(() => ({ available: true, encrypts: true, locked: false, primed: [] as string[][] }));
const preview = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("electron", () => ({ app: { getPath: () => folder.userData } }));
vi.mock("../preview-session", () => ({
	MAX_SHARED_COOKIES: 300,
	readPreviewCookies: (...args: unknown[]) => preview.read(...args),
}));
vi.mock("../../secret-storage", () => ({
	getSecureStorageStatus: () => ({ keyringAvailable: keyring.available }),
	prepareSecrets: async () => undefined,
	primeSecretFiles: async (files: string[]) => {
		keyring.primed.push(files);
	},
	isEncryptedSecret: (value: unknown) => typeof value === "string" && value.startsWith("enc:"),
	encryptSecret: (value: string) =>
		keyring.encrypts ? `enc:${Buffer.from(value).toString("base64")}` : value,
	decryptSecret: (value: string) =>
		keyring.locked ? undefined : Buffer.from(value.slice(4), "base64").toString("utf-8"),
}));

import { libraryPath } from "../library-file";
import { PersonaFailure, deletePersona, hostOf, listPersonas, personaCookies, readCookie, savePersona } from "../personas";

const cookie = (overrides: Record<string, unknown> = {}) => ({
	name: "sid",
	value: "test-session-0000",
	domain: "localhost",
	hostOnly: true,
	path: "/",
	secure: false,
	httpOnly: true,
	session: true,
	expirationDate: undefined,
	sameSite: "lax",
	...overrides,
});
const ORIGIN = "http://localhost:5173";
const file = () => libraryPath("personas");

describe("personas", () => {
	beforeEach(() => {
		folder.userData = mkdtempSync(path.join(tmpdir(), "personas-"));
		Object.assign(keyring, { available: true, encrypts: true, locked: false, primed: [] });
		preview.read = vi.fn(async () => [cookie(), cookie({ name: "theme", value: "dark", session: false, expirationDate: 2e9 })]);
	});

	afterEach(() => {
		rmSync(folder.userData, { recursive: true, force: true });
	});

	it("saves the preview's cookies for the server, encrypted, and lists only their summary", async () => {
		const [admin] = await savePersona("Admin", ORIGIN);
		expect(preview.read).toHaveBeenCalledWith(ORIGIN);
		expect(admin).toEqual({
			id: expect.stringMatching(/^persona-[0-9a-f-]{36}$/),
			name: "Admin",
			host: "http://localhost",
			cookieCount: 2,
			savedAt: expect.any(Number),
		});
		const onDisk = readFileSync(file(), "utf-8");
		expect(onDisk).not.toContain("test-session-0000");
		expect(JSON.parse(onDisk).entries[0].cookies).toMatch(/^enc:/);
		expect(await listPersonas()).toEqual([admin]);
	});

	it("replays them on the same host, whatever the port, and nowhere else", async () => {
		const [admin] = await savePersona("Admin", ORIGIN);
		const cookies = await personaCookies(admin.id, "http://localhost:3000");
		expect(cookies.map((entry) => entry.name)).toEqual(["sid", "theme"]);
		expect(cookies[0].value).toBe("test-session-0000");
		expect(keyring.primed).toEqual([[file()]]);
		await expect(personaCookies(admin.id, "https://localhost:5173")).rejects.toMatchObject({ code: "persona-elsewhere" });
		await expect(personaCookies(admin.id, "http://127.0.0.1:5173")).rejects.toMatchObject({ code: "persona-elsewhere" });
	});

	it("refuses to save without a keyring, or when it did not encrypt, and writes nothing", async () => {
		keyring.available = false;
		await expect(savePersona("Admin", ORIGIN)).rejects.toMatchObject({ code: "encryption-unavailable" });
		expect(preview.read).not.toHaveBeenCalled();
		keyring.available = true;
		keyring.encrypts = false;
		await expect(savePersona("Admin", ORIGIN)).rejects.toMatchObject({ code: "encryption-unavailable" });
		expect(() => readFileSync(file())).toThrow();
	});

	it("names a preview it cannot read, or one that sends no cookie", async () => {
		preview.read = vi.fn(async () => {
			throw new Error("gone");
		});
		await expect(savePersona("Admin", ORIGIN)).rejects.toMatchObject({ code: "session-failed" });
		preview.read = vi.fn(async () => [cookie({ sameSite: "bogus" })]);
		await expect(savePersona("Admin", ORIGIN)).rejects.toMatchObject({ code: "no-cookies" });
	});

	it("caps the list, deletes by id and names an unknown one", async () => {
		for (let index = 0; index < 10; index++) await savePersona(`P${index}`, ORIGIN);
		const error = await savePersona("One more", ORIGIN).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(PersonaFailure);
		expect(error).toMatchObject({ code: "too-many" });
		const [first] = await listPersonas();
		expect(await deletePersona(first.id)).toHaveLength(9);
		await expect(deletePersona(first.id)).rejects.toMatchObject({ code: "unknown-persona" });
		await expect(personaCookies(first.id, ORIGIN)).rejects.toMatchObject({ code: "unknown-persona" });
	});

	it("names a persona the keyring no longer gives back", async () => {
		const [admin] = await savePersona("Admin", ORIGIN);
		keyring.locked = true;
		await expect(personaCookies(admin.id, ORIGIN)).rejects.toMatchObject({ code: "persona-locked" });
	});

	it("reads what it decrypts as data, and drops a hand-edited entry", async () => {
		mkdirSync(path.dirname(file()), { recursive: true });
		const sealed = (value: string) => `enc:${Buffer.from(value).toString("base64")}`;
		const entry = {
			id: "persona-11111111-2222-4333-8444-555555555555",
			name: "Admin",
			host: "http://localhost",
			cookieCount: 1,
			savedAt: 1,
		};
		writeFileSync(
			file(),
			JSON.stringify({
				entries: [
					{ ...entry, cookies: sealed(JSON.stringify([cookie(), { name: "" }, "junk"])) },
					{ ...entry, id: "persona-22222222-2222-4333-8444-555555555555", cookies: sealed("not json") },
					{ ...entry, id: "persona-33333333-2222-4333-8444-555555555555", cookies: sealed('{"a":1}') },
					{ ...entry, id: "persona-44444444-2222-4333-8444-555555555555", cookies: "in clear" },
					{ ...entry, id: "../../etc", cookies: sealed("[]") },
					{ ...entry, id: "persona-55555555-2222-4333-8444-555555555555", host: "file:///etc", cookies: sealed("[]") },
					{ ...entry, id: "persona-66666666-2222-4333-8444-555555555555", cookieCount: 0, cookies: sealed("[]") },
					{ ...entry, id: "persona-77777777-2222-4333-8444-555555555555", cookieCount: 1.5, cookies: sealed("[]") },
					{ ...entry, id: "persona-88888888-2222-4333-8444-555555555555", savedAt: "now", cookies: sealed("[]") },
					null,
				],
			}),
		);
		const listed = await listPersonas();
		expect(listed.map((persona) => persona.id)).toEqual([
			"persona-11111111-2222-4333-8444-555555555555",
			"persona-22222222-2222-4333-8444-555555555555",
			"persona-33333333-2222-4333-8444-555555555555",
		]);
		expect(await personaCookies(listed[0].id, ORIGIN)).toEqual([cookie()]);
		await expect(personaCookies(listed[1].id, ORIGIN)).rejects.toMatchObject({ code: "persona-locked" });
		await expect(personaCookies(listed[2].id, ORIGIN)).rejects.toMatchObject({ code: "persona-locked" });
	});

	it("names a list it cannot write", async () => {
		writeFileSync(path.join(folder.userData, "device-matrix"), "");
		await expect(savePersona("Admin", ORIGIN)).rejects.toMatchObject({ code: "write-failed" });
	});
});

describe("readCookie and hostOf", () => {
	it("keeps a cookie's own fields only", () => {
		expect(readCookie({ ...cookie(), extra: "x" })).toEqual(cookie());
		expect(readCookie(cookie({ domain: undefined, hostOnly: false }))).toMatchObject({ domain: undefined });
	});

	it.each([
		["nothing", null],
		["no name", cookie({ name: "" })],
		["an overlong value", cookie({ value: "x".repeat(4097) })],
		["no path", cookie({ path: "" })],
		["a domain as a number", cookie({ domain: 5 })],
		["an endless expiry", cookie({ expirationDate: Number.POSITIVE_INFINITY })],
		["an expiry as text", cookie({ expirationDate: "soon" })],
		["a flag as text", cookie({ secure: "yes" })],
		["an unknown same-site", cookie({ sameSite: "none" })],
	])("refuses %s", (_label, raw) => {
		expect(readCookie(raw)).toBeNull();
	});

	it("keeps the scheme and the host name of an origin", () => {
		expect(hostOf("http://localhost:5173")).toBe("http://localhost");
		expect(hostOf("https://app.test:8443")).toBe("https://app.test");
	});
});
