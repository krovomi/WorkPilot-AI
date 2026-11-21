/**
 * The two short answers the voice assistant reads by itself, with no model: a
 * spoken « stop » (stop the running agents after their current step) and the
 * « yes » / « no » that confirms or drops what it asked about.
 *
 * Both only match a short sentence made of these words, so « stop the server
 * from caching » or « oui mais ajoute un test » are left to the usual reading.
 * The stop is never offered to the model (`main/voice-assistant/interpret.ts`):
 * only a person saying it, then confirming it, stops anything.
 */

import { normalizeSpeech } from "./voice-intent";

/** Words that ask the agents to stop, in the assistant's languages. */
const STOP_WORDS = new Set([
	"stop",
	"stoppe",
	"stopper",
	"arrete",
	"arretez",
	"arreter",
	"arrete-toi",
	"arretez-vous",
	"pause",
	"attends",
	"attendez",
	"halt",
	"wait",
	"para",
	"parad",
	"detente",
	"stopp",
	"anhalten",
	"basta",
	"fermati",
	"fermatevi",
	"pare",
	"stoppen",
]);

/** Words that may stand around a stop word: « arrête tout », « stop the agents ». */
const STOP_FILLER = new Set([
	"tout",
	"toi",
	"vous",
	"les",
	"l'agent",
	"agent",
	"agents",
	"maintenant",
	"tous",
	"s'il",
	"te",
	"plait",
	"non",
	"everything",
	"all",
	"the",
	"now",
	"please",
	"no",
	"todo",
	"ahora",
	"alles",
	"jetzt",
	"tutto",
	"ora",
	"tudo",
	"agora",
	"nu",
]);

const YES = new Set([
	"oui",
	"ouais",
	"confirme",
	"confirmer",
	"vas-y",
	"d'accord",
	"ok",
	"okay",
	"yes",
	"yeah",
	"yep",
	"confirm",
	"sure",
	"si",
	"ja",
	"sim",
	"claro",
	"certo",
]);

const NO = new Set([
	"non",
	"annule",
	"annuler",
	"laisse",
	"no",
	"nope",
	"cancel",
	"nein",
	"nee",
	"nao",
	"cancela",
	"annulla",
]);

/** At most this many words: a command, not a sentence about something else. */
const MAX_WORDS = 5;

function words(text: string): string[] {
	return normalizeSpeech(text)
		.replace(/[.,!?;:«»"()]/g, " ")
		.split(" ")
		.filter(Boolean);
}

/** « Stop », « arrête tout », « stop the agents now »: true. */
export function readStopCommand(text: string): boolean {
	const said = words(text);
	if (said.length === 0 || said.length > MAX_WORDS) return false;
	if (!said.some((word) => STOP_WORDS.has(word))) return false;
	return said.every((word) => STOP_WORDS.has(word) || STOP_FILLER.has(word));
}

/** « Oui », « yes please », « non annule »: the answer; anything else is null. */
export function readConfirmation(text: string): "yes" | "no" | null {
	const said = words(text).filter((word) => !STOP_FILLER.has(word) || NO.has(word));
	if (said.length === 0 || said.length > MAX_WORDS) return null;
	const yes = said.some((word) => YES.has(word));
	const no = said.some((word) => NO.has(word));
	if (yes === no) return null;
	if (!said.every((word) => YES.has(word) || NO.has(word))) return null;
	return yes ? "yes" : "no";
}
