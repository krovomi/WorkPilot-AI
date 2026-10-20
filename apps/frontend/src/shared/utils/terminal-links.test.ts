import { describe, expect, it } from "vitest";
import {
	extractLatestAuthUrl,
	extractTerminalUrls,
} from "./terminal-links";

/** Le cas réel : l'URL OAuth de Claude Code, repliée à 80 colonnes. */
const CLAUDE_AUTH_URL =
	"https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&state=f9IDpqkIWsu52lIeammp5o-52OC7aVzj2rrRbpa8X-xc";

function wrapAt(text: string, columns: number): string {
	const lines: string[] = [];
	for (let index = 0; index < text.length; index += columns) {
		lines.push(text.slice(index, index + columns));
	}
	return lines.join("\n");
}

describe("extractTerminalUrls", () => {
	it("rend une URL qui tient sur une ligne", () => {
		expect(extractTerminalUrls("Open https://example.com/login now")).toEqual([
			"https://example.com/login",
		]);
	});

	it("recolle une URL que le programme a repliée lui-même", () => {
		const screen = [
			"Browser didn't open? Use the url below to sign in (c to copy)",
			"",
			wrapAt(CLAUDE_AUTH_URL, 80),
			"",
			"Paste code here if prompted >",
		].join("\n");

		expect(extractTerminalUrls(screen, { columns: 80 })).toEqual([
			CLAUDE_AUTH_URL,
		]);
	});

	it("ne recolle pas une ligne qui s'est terminée d'elle-même", () => {
		const screen = ["Visit https://example.com/login", "Then come back"].join(
			"\n",
		);
		expect(extractTerminalUrls(screen, { columns: 80 })).toEqual([
			"https://example.com/login",
		]);
	});

	it("ignore les séquences ANSI autour de l'URL", () => {
		const screen = "\x1b[4;34mhttps://example.com/oauth/authorize\x1b[0m";
		expect(extractTerminalUrls(screen)).toEqual([
			"https://example.com/oauth/authorize",
		]);
	});

	it("retire la ponctuation finale d'une phrase", () => {
		expect(extractTerminalUrls("Go to https://example.com/login.")).toEqual([
			"https://example.com/login",
		]);
	});

	it("dédoublonne les redessins successifs du même écran", () => {
		const screen = [CLAUDE_AUTH_URL, CLAUDE_AUTH_URL].join("\n");
		expect(extractTerminalUrls(screen)).toEqual([CLAUDE_AUTH_URL]);
	});

	it("ne rend rien pour un texte sans URL", () => {
		expect(extractTerminalUrls("Paste code here if prompted >")).toEqual([]);
		expect(extractTerminalUrls("")).toEqual([]);
	});

	it("refuse ce qui n'est pas une URL analysable", () => {
		expect(extractTerminalUrls("https://")).toEqual([]);
	});
});

describe("extractLatestAuthUrl", () => {
	it("choisit l'URL de connexion parmi les autres", () => {
		const screen = [
			"Docs: https://example.com/docs/getting-started",
			`Sign in: ${CLAUDE_AUTH_URL}`,
		].join("\n");
		expect(extractLatestAuthUrl(screen, { columns: 200 })).toBe(
			CLAUDE_AUTH_URL,
		);
	});

	it("rend la plus récente quand le programme a réessayé", () => {
		const screen = [
			"https://example.com/oauth/authorize?state=first",
			"expired, retrying",
			"https://example.com/oauth/authorize?state=second",
		].join("\n");
		expect(extractLatestAuthUrl(screen, { columns: 80 })).toBe(
			"https://example.com/oauth/authorize?state=second",
		);
	});

	it("ne propose rien quand aucune URL ne parle de connexion", () => {
		expect(
			extractLatestAuthUrl("See https://example.com/docs for details"),
		).toBeNull();
	});
});
