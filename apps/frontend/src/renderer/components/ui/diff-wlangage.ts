/**
 * WLangage (WinDev, WebDev, WinDev Mobile) for the diff viewer.
 *
 * CodeMirror has no WLangage grammar, and the files a task changes are WinDev
 * elements saved in the text format: YAML written by the editor, with the
 * WLangage code in `code : |1+` blocks (docs/architecture/windev.md). A diff
 * hunk is a fragment of such a file, so this mode reads each line on its own:
 *
 * - a line that is a key of the format (`  name : BTN_Valider`) shows the key
 *   as a property; the values only the editor writes (`internal_properties`,
 *   `identifier`, `procedure_id`) and the block headers are dimmed (`meta`),
 *   since a reviewer never needs to read base64;
 * - any other line is WLangage: keywords in French or English, with or
 *   without accents, comments, strings, numbers, types and constants.
 */
import {
	LanguageDescription,
	LanguageSupport,
	StreamLanguage,
	type StreamParser,
} from "@codemirror/language";

/** The WinDev element files saved in the text format (`windev.files`). */
export const WLANGAGE_EXTENSIONS = ["wdp", "wdw", "wdc", "wdg", "wde", "wdt", "wwh"];

const KEYWORDS = new Set(
	[
		// French
		"si", "alors", "sinon", "fin", "pour", "tantque", "boucle", "sortir",
		"continuer", "renvoyer", "retour", "selon", "cas", "autre", "procédure",
		"procedure", "fonction", "et", "ou", "pas", "dans", "est", "un", "une",
		"de", "à", "a", "quand", "exception", "faire", "tout", "toute", "chaque",
		"classe", "hérite", "herite", "local", "locale", "global", "globale",
		"public", "publique", "privé", "prive", "protégé", "protege", "constant",
		"constante", "structure", "externe", "dynamique", "allera", "lorsque",
		"implémente", "implemente", "interface", "abstrait", "virtuel",
		// English
		"if", "then", "else", "end", "for", "while", "loop", "break", "continue",
		"return", "switch", "case", "other", "function", "and", "or", "not", "in",
		"is", "an", "to", "step", "each", "all", "class", "inherits", "when",
		"do", "private", "protected", "constant", "external", "dynamic",
	],
);

const TYPES = new Set([
	"entier", "chaîne", "chaine", "réel", "reel", "booléen", "booleen",
	"monétaire", "monetaire", "numérique", "numerique", "date", "heure",
	"dateheure", "durée", "duree", "tableau", "buffer", "variant", "caractère",
	"caractere", "int", "string", "real", "boolean", "currency", "numeric",
	"array", "time", "datetime", "duration",
]);

const CONSTANTS = new Set(["vrai", "faux", "null", "true", "false"]);

/** Keys whose value only the editor writes: dimmed, never read. */
const OPAQUE_KEYS = new Set(["internal_properties", "identifier", "procedure_id"]);

const KEY_LINE = /^(\s*)(-\s+)?([a-z_]+)( :)/;
const BLOCK_HEADER = /^\s*\|\d?[+-]?\s*$/;

interface State {
	/** Inside a `/* … *\/` comment that started on an earlier line. */
	comment: boolean;
	/** The line is a key of the format; its key is not read yet. */
	key: boolean;
	/** Rest of the line is the value of the key just read. */
	value: "" | "opaque" | "plain";
}

function word(stream: Parameters<StreamParser<State>["token"]>[0]): string | null {
	const match = stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
	return Array.isArray(match) ? match[0] : null;
}

const parser: StreamParser<State> = {
	name: "wlangage",
	startState: () => ({ comment: false, key: false, value: "" }),
	copyState: (state) => ({ ...state }),
	token(stream, state) {
		if (stream.sol()) {
			state.value = "";
			state.key = !state.comment && Array.isArray(stream.match(KEY_LINE, false));
		}
		if (state.comment) {
			if (stream.skipTo("*/")) {
				stream.next();
				stream.next();
				state.comment = false;
			} else {
				stream.skipToEnd();
			}
			return "comment";
		}
		if (stream.eatSpace()) return null;
		if (state.key) {
			if (stream.match(/^-/)) return "operator";
			const key = word(stream) ?? "";
			state.key = false;
			state.value = OPAQUE_KEYS.has(key) ? "opaque" : "plain";
			return state.value === "opaque" ? "meta" : "propertyName";
		}
		if (state.value) {
			if (stream.match(":")) return "operator";
			const rest = stream.string.slice(stream.pos);
			stream.skipToEnd();
			if (state.value === "opaque" || BLOCK_HEADER.test(rest)) return "meta";
			return "string";
		}
		if (stream.match("//")) {
			stream.skipToEnd();
			return "comment";
		}
		if (stream.match("/*")) {
			state.comment = true;
			return "comment";
		}
		if (stream.match(/^"(?:[^"]|"")*"?/)) return "string";
		if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
		const name = word(stream);
		if (name) {
			const lower = name.toLowerCase();
			if (KEYWORDS.has(lower)) return "keyword";
			if (TYPES.has(lower)) return "typeName";
			if (CONSTANTS.has(lower)) return "bool";
			return "variableName";
		}
		if (stream.match(/^(?:<=|>=|<>|[=<>+\-*/:])/)) return "operator";
		stream.next();
		return null;
	},
};

const support = new LanguageSupport(StreamLanguage.define(parser));

/** The diff viewer's description of WLangage, for `findLanguage`. */
export const WLANGAGE = LanguageDescription.of({
	name: "WLangage",
	alias: ["windev", "webdev"],
	extensions: WLANGAGE_EXTENSIONS,
	support,
});
