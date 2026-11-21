/**
 * The optional wake word (issue #385): « Hey WorkPilot », or the person's own
 * phrase. It is read in the transcription of the local Whisper, like every
 * other sentence: no keyword model, no new dependency, and nothing leaves the
 * computer. Whisper writes the phrase in many ways (« Hey, Work Pilot. »,
 * « hé WorkPilot »), so words are compared without case, accents, punctuation
 * or the spaces between them, and the greeting may be any of a short list.
 */

export const DEFAULT_WAKE_PHRASE = "Hey WorkPilot";
export const MAX_WAKE_PHRASE = 40;
/** The phrase may come after a filler or two (« euh, hey WorkPilot »). */
const MAX_LEAD_WORDS = 2;
const GREETINGS = new Set(["hey", "hei", "he", "hay", "hi", "eh", "ok", "okay", "dis"]);

/** The setting's phrase, or the default when it is missing or unusable. */
export function wakePhrase(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_WAKE_PHRASE;
	const phrase = value.replace(/\s+/g, " ").trim();
	if (phrase.length > MAX_WAKE_PHRASE || squash(phrase).length < 3) return DEFAULT_WAKE_PHRASE;
	return phrase;
}

/** A word without case, accents or punctuation. */
function squash(word: string): string {
	return word
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function words(text: string): { raw: string; key: string }[] {
	return text
		.split(/\s+/)
		.map((raw) => ({ raw, key: squash(raw) }))
		.filter((word) => word.key);
}

/**
 * Whether the sentence starts with the wake phrase, and what was said after
 * it (`rest`, empty when the phrase was said alone). Null when it was not said.
 */
export function readWakePhrase(sentence: string, phrase: string): { rest: string } | null {
	const wanted = words(phrase).map((word) => word.key);
	if (wanted.length === 0) return null;
	const greeting = wanted.length > 1 && GREETINGS.has(wanted[0]);
	const body = (greeting ? wanted.slice(1) : wanted).join("");
	const heard = words(sentence);
	for (let lead = 0; lead <= MAX_LEAD_WORDS && lead < heard.length; lead += 1) {
		let at = lead;
		if (greeting) {
			if (!GREETINGS.has(heard[at].key)) continue;
			at += 1;
		}
		let joined = "";
		while (at < heard.length && joined.length < body.length) {
			joined += heard[at].key;
			at += 1;
		}
		if (joined === body) {
			const rest = heard
				.slice(at)
				.map((word) => word.raw)
				.join(" ")
				.replace(/^[\s,.;:!?-]+/u, "")
				.trim();
			return { rest };
		}
	}
	return null;
}
