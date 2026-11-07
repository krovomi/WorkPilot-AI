/**
 * The voice assistant's local reading of a sentence: no model, no network.
 *
 * It answers the plain commands in French and English (« crée-moi une tâche
 * pour… », « ouvre le Kanban », « open settings ») and says when it is sure.
 * A sentence it is not sure of goes to the feature model
 * (`main/voice-assistant/interpret.ts`); this reading is the fallback when no
 * model answers.
 */

import type { VoiceDestination, VoiceIntent } from "@shared/types/voice-assistant";
import { VIEW_HINTS } from "./voice-destinations";

export interface LocalReading {
	intent: VoiceIntent;
	/** Sure enough to act without asking the model. */
	confident: boolean;
}

/** Lower case, no accents, typographic apostrophes and dashes folded. */
export function normalizeSpeech(text: string): string {
	return foldChars(text).map((c) => c.folded).join("").replace(/\s+/g, " ").trim();
}

interface FoldedChar {
	folded: string;
	/** Index of the character in the original text. */
	at: number;
}

function foldChars(text: string): FoldedChar[] {
	const out: FoldedChar[] = [];
	let at = 0;
	for (const char of text) {
		const folded = char
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "")
			.replace(/[’‘`´]/g, "'")
			.replace(/[‐‑–—]/g, "-")
			.toLowerCase();
		for (const piece of folded) out.push({ folded: piece, at });
		at += char.length;
	}
	return out;
}

const POLITE =
	"(?:(?:est-ce que tu peux|est ce que tu peux|peux-tu|peux tu|tu peux|pourrais-tu|pourrais tu|merci de|je voudrais|je veux|j'aimerais|can you|could you|would you|please|i want to|i'd like to|s'il te plait)\\s+)*";
const CREATE_VERB =
	"(?:cree|creer|crees|creez|ajoute|ajouter|ajoutez|fais|faire|mets|mettre|ouvre|ouvrir|create|add|make|open|new|nouvelle)";
const ME = "(?:[- ](?:moi|nous|me|us|m'en))?";
const TASK_NOUN = "(?:tache|taches|ticket|carte|card|task|todo)";
const CREATE_TASK = new RegExp(
	`^${POLITE}${CREATE_VERB}${ME}\\s+(?:(?:une?|a|an|la|le|the|ma|my)\\s+)?(?:(?:nouvelle|new)\\s+)?${TASK_NOUN}\\b`,
);
const NEW_TASK_ALONE = /^(?:une?\s+)?(?:nouvelle tache|new task)$/;

/** Words between the task noun and what the task is about. */
const LEAD_IN =
	/^(?:\s|[:,.\-–]|dans (?:le|mon|ce) (?:kanban|tableau|board)|sur (?:le|mon) (?:kanban|tableau)|au kanban|in (?:the|my) (?:kanban|board)|on (?:the|my) (?:kanban|board)|to (?:the|my) (?:kanban|board)|pour (?:que )?|afin de |qui (?:consiste a |doit )?|de |d'|ou |intitulee |nommee |appelee |avec (?:le titre|comme titre) |to |for |that |which |called |named |titled |about )/;

const NAV_VERB =
	/\b(?:ouvre|ouvrir|ouvrez|ouvres|va|vas|aller|allez|affiche|afficher|affichez|montre|montrer|montrez|navigue|naviguer|emmene|amene|lance|lancer|passe|retourne|voir|open|go|show|display|navigate|take me|switch|launch|bring up)\b/;

const SETTINGS = /\b(?:parametres|reglages|preferences|settings|preferences de l'app)\b/;

/** What the speaker wants, as far as words alone can tell. */
export function readVoiceCommand(
	transcript: string,
	destinations: readonly VoiceDestination[],
): LocalReading {
	const folded = foldChars(transcript);
	const text = folded.map((c) => c.folded).join("");
	const norm = normalizeSpeech(transcript);
	if (!norm) return { intent: { kind: "unknown" }, confident: false };

	const create = CREATE_TASK.exec(text.replace(/\s+/g, " ").trimStart());
	if (create) {
		const rest = taskBody(transcript, folded, create[0].length);
		if (!rest) return { intent: { kind: "new-task" }, confident: true };
		return {
			intent: { kind: "create-task", title: titleFrom(rest), description: rest },
			confident: true,
		};
	}
	if (NEW_TASK_ALONE.test(norm)) return { intent: { kind: "new-task" }, confident: true };

	const navigating = NAV_VERB.test(norm);
	if (SETTINGS.test(norm) && (navigating || norm.split(" ").length <= 3)) {
		return { intent: { kind: "open-settings" }, confident: true };
	}

	const ranked = rankDestinations(norm, destinations);
	const [best, second] = ranked;
	if (!best || best.score === 0) return { intent: { kind: "unknown" }, confident: false };
	const clear = !second || second.score < best.score;
	return {
		intent: { kind: "navigate", view: best.id },
		// A view named in full is sure; one found by its purpose needs a verb
		// (« ouvre… ») and no tie, otherwise the model decides.
		confident: clear && (best.score >= 100 || navigating),
	};
}

/**
 * The task's text in the speaker's own spelling: everything after the request
 * formula, without the « dans le kanban pour » that leads into it.
 */
function taskBody(original: string, folded: FoldedChar[], matchedLength: number): string {
	// `matchedLength` counts the folded text with spaces collapsed and the
	// leading ones dropped: walk the folded characters the same way.
	let count = 0;
	let index = 0;
	let previousSpace = true;
	while (index < folded.length && count < matchedLength) {
		const isSpace = /\s/.test(folded[index].folded);
		if (!(isSpace && previousSpace)) count++;
		previousSpace = isSpace;
		index++;
	}
	let rest = index < folded.length ? original.slice(folded[index].at) : "";
	for (;;) {
		const chars = foldChars(rest);
		const lead = LEAD_IN.exec(chars.map((c) => c.folded).join(""));
		if (!lead || lead[0].length === 0) break;
		rest = lead[0].length >= chars.length ? "" : rest.slice(chars[lead[0].length].at);
	}
	return rest.replace(/[\s.!?]+$/u, "").trim();
}

/** A short title from the task's text: its first clause, at most 80 characters. */
export function titleFrom(text: string): string {
	const clause = text.split(/[.!?\n]/u)[0]?.trim() ?? "";
	let title = clause.length > 80 ? clause.slice(0, 80).replace(/\s+\S*$/u, "") : clause;
	title = title.replace(/[,;:\s]+$/u, "");
	return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

interface RankedDestination {
	id: string;
	score: number;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(sentence: string, phrase: string): boolean {
	if (!phrase) return false;
	return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(phrase)}(?:$|[^a-z0-9])`).test(sentence);
}

/** Destinations by how well the sentence names them: full label, then purpose words. */
export function rankDestinations(
	sentence: string,
	destinations: readonly VoiceDestination[],
): RankedDestination[] {
	return destinations
		.map((destination) => {
			const label = normalizeSpeech(destination.label);
			let score = containsPhrase(sentence, label) ? 100 + label.length : 0;
			for (const word of VIEW_HINTS[destination.id]?.words ?? []) {
				if (containsPhrase(sentence, word) || (word.length >= 6 && sentence.includes(word)))
					score += 10;
			}
			return { id: destination.id, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score);
}
