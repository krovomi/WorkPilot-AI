/**
 * The keyword half of « Interroger le tableau » (docs/architecture/board-ask.md):
 * a small BM25 over the tickets of one board, written for any language.
 *
 * No dictionary and no dependency. Words are folded (case, accents), cut to a
 * stem of {@link STEM_LENGTH} letters, and a short query word matches the stems
 * it begins ("admin" finds "administration"). Scripts written without spaces
 * (Chinese, Japanese, Korean, Thai) are read as pairs of characters. The words
 * the question shares with a ticket in another language come from the model,
 * which adds them to the query (`board-ask-service.ts`); without a model this
 * is what answers on its own.
 */

/** Letters a stem keeps: "administration" and "administrer" meet on "admini". */
export const STEM_LENGTH = 6;
/** A query stem shorter than this never matches by prefix ("ui" stays "ui"). */
const MIN_PREFIX = 3;
const K1 = 1.2;
const B = 0.75;

/** Scripts written without spaces between words, read as character pairs. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const WORD = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

/**
 * Words that say nothing about a subject, in the languages a board is most
 * often written in. Folded already (no accents).
 */
const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
	en: "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on or our should so than that the their them then there these they this to was we were what when where which who why will with would you your".split(
		" ",
	),
	fr: "a au aux avec ce ces cette comment dans de des du elle en est et etait ete il ils je la le les leur lui ma mais me mes moi mon ne nos notre nous on ou par pas pour qu que quel quelle quels qui sa se ses si son sur ta te tes toi ton tu un une vos votre vous y".split(
		" ",
	),
	es: "al como con de del el en es esta este fue ha la las lo los mas para pero por que se sin su sus un una y".split(
		" ",
	),
	de: "auf das dem den der des die ein eine einen fur hat ich ist mit nicht oder sich sie und von war wie wir zu".split(
		" ",
	),
	it: "al che come con da del della di e gli il in la le lo nel per piu questo si sono un una".split(" "),
	pt: "ao com como da das de do dos e em foi isso mais mas na no os para por que se sem um uma".split(" "),
	nl: "aan als bij dat de die een en het hoe in is met niet of op te van voor wat wij zijn".split(" "),
};

const ALL_STOPWORDS = new Set(Object.values(STOPWORDS).flat());

/** The languages {@link detectLanguages} can name. */
export const DETECTABLE_LANGUAGES = Object.keys(STOPWORDS);

/** Lower case, accents removed: « Révisée » and "revisee" are one word. */
export function foldText(text: string): string {
	return text.normalize("NFKD").replace(MARKS, "").toLowerCase();
}

function stem(word: string): string {
	// A trailing plural "s" first, so "pages" and "page" meet before the cut.
	const singular = word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
	return singular.slice(0, STEM_LENGTH);
}

function pairs(run: string): string[] {
	const chars = Array.from(run);
	if (chars.length < 2) return chars;
	const out: string[] = [];
	for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
	return out;
}

/** The terms of a text, in order, repeats kept (they are its frequencies). */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	for (const word of foldText(text).match(WORD) ?? []) {
		if (UNSPACED.test(word)) {
			terms.push(...pairs(word));
			continue;
		}
		if (word.length < 2 || ALL_STOPWORDS.has(word)) continue;
		terms.push(stem(word));
	}
	return terms;
}

/**
 * The languages the texts are written in, most used first: each text votes
 * for the language whose common words it uses most, and a language that wins
 * fewer than one text in ten is left out. Empty when nothing can be told.
 */
export function detectLanguages(texts: readonly string[]): string[] {
	const votes = new Map<string, number>();
	let voters = 0;
	for (const text of texts) {
		const words = foldText(text).match(WORD) ?? [];
		let best = "";
		let bestCount = 0;
		for (const [language, list] of Object.entries(STOPWORDS)) {
			const set = new Set(list);
			const count = words.filter((w) => set.has(w)).length;
			if (count > bestCount) {
				best = language;
				bestCount = count;
			}
		}
		if (bestCount >= 2) {
			voters++;
			votes.set(best, (votes.get(best) ?? 0) + 1);
		}
	}
	return [...votes.entries()]
		.filter(([, count]) => count * 10 >= voters)
		.sort((a, b) => b[1] - a[1])
		.map(([language]) => language);
}

/** One field of a document and how much a word found in it counts. */
export interface SearchField {
	text: string;
	weight: number;
}

export interface SearchDocument {
	id: string;
	fields: readonly SearchField[];
}

/** A word to look for and how much it counts (the question's own count 1). */
export interface QueryTerm {
	text: string;
	weight: number;
}

export interface SearchHit {
	id: string;
	score: number;
}

interface IndexedDocument {
	id: string;
	frequencies: Map<string, number>;
	length: number;
}

/** The documents, indexed once, to be asked several queries. */
export class KeywordIndex {
	private readonly documents: IndexedDocument[];
	private readonly documentFrequency = new Map<string, number>();
	private readonly averageLength: number;

	constructor(documents: readonly SearchDocument[]) {
		this.documents = documents.map((document) => {
			const frequencies = new Map<string, number>();
			let length = 0;
			for (const field of document.fields) {
				for (const term of tokenize(field.text)) {
					frequencies.set(term, (frequencies.get(term) ?? 0) + field.weight);
					length += field.weight;
				}
			}
			for (const term of frequencies.keys()) {
				this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
			}
			return { id: document.id, frequencies, length };
		});
		const total = this.documents.reduce((sum, d) => sum + d.length, 0);
		this.averageLength = this.documents.length > 0 ? total / this.documents.length || 1 : 1;
	}

	get size(): number {
		return this.documents.length;
	}

	/**
	 * The index terms a query stem stands for: itself, those it begins when it
	 * is short ("admin" → "admini"), and a short word it begins with
	 * ("admini" → "admin").
	 */
	private expand(stemmed: string): string[] {
		if (UNSPACED.test(stemmed)) return this.documentFrequency.has(stemmed) ? [stemmed] : [];
		const short = stemmed.length >= MIN_PREFIX && stemmed.length < STEM_LENGTH;
		const out: string[] = [];
		for (const term of this.documentFrequency.keys()) {
			if (
				term === stemmed ||
				(short && term.startsWith(stemmed)) ||
				(term.length >= MIN_PREFIX + 2 && term.length < STEM_LENGTH && stemmed.startsWith(term))
			) {
				out.push(term);
			}
		}
		return out;
	}

	/** The documents that share a term with the query, best first, at most `limit`. */
	search(query: readonly QueryTerm[], limit: number): SearchHit[] {
		const weights = new Map<string, number>();
		for (const { text, weight } of query) {
			if (!(weight > 0)) continue;
			for (const term of tokenize(text)) {
				weights.set(term, Math.max(weights.get(term) ?? 0, weight));
			}
		}
		const scores = new Map<string, number>();
		const count = this.documents.length;
		for (const [queryTerm, weight] of weights) {
			for (const term of this.expand(queryTerm)) {
				const df = this.documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
				for (const document of this.documents) {
					const tf = document.frequencies.get(term);
					if (!tf) continue;
					const norm = tf + K1 * (1 - B + (B * document.length) / this.averageLength);
					const score = weight * idf * ((tf * (K1 + 1)) / norm);
					scores.set(document.id, (scores.get(document.id) ?? 0) + score);
				}
			}
		}
		return [...scores.entries()]
			.map(([id, score]) => ({ id, score }))
			.sort((a, b) => b.score - a.score)
			.slice(0, Math.max(0, limit));
	}
}
