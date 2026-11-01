/**
 * Text and links shared into the app from another one (the system share
 * sheet, through `expo-sharing`), turned into the start of a new card.
 *
 * What is shared is someone else's text: it is data, never an instruction.
 * It only prefills the New card form, bounded and stripped of control
 * characters; nothing is created, fetched or opened until the person reads it
 * and presses Create. A shared link is kept as text: the app never loads it.
 */

import { MAX_DESCRIPTION, MAX_TITLE } from "./limits";

/** A payload as `expo-sharing` hands it (`SharePayload`), reduced to what is read. */
export interface SharedItem {
	value?: string | null;
	shareType?: string | null;
}

export interface ShareDraft {
	title: string;
	description: string;
}

/** The most items read from one share; the rest are ignored. */
export const MAX_SHARED_ITEMS = 10;
/** A title taken from the first line is cut shorter than the field allows. */
export const SHARED_TITLE_LENGTH = 120;

const TEXT_TYPES = new Set(["text", "url"]);

/** A control character other than tab and newline, or a bidi override that reorders what is shown. */
function isControl(code: number): boolean {
	if (code < 0x20) return code !== 0x09 && code !== 0x0a;
	return (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export function cleanText(raw: string, max: number): string {
	const text = raw.replace(/\r\n?/g, "\n").slice(0, max * 2);
	let out = "";
	for (const char of text) {
		if (!isControl(char.codePointAt(0) ?? 0)) out += char;
		if (out.length >= max) break;
	}
	return out.slice(0, max).trim();
}

/** The draft a share gives, or `null` when it holds no text or link. */
export function draftFromShare(items: readonly SharedItem[]): ShareDraft | null {
	const parts: string[] = [];
	for (const item of items.slice(0, MAX_SHARED_ITEMS)) {
		if (!TEXT_TYPES.has(item.shareType ?? "text")) continue;
		const text = cleanText(String(item.value ?? ""), MAX_DESCRIPTION);
		if (text) parts.push(text);
	}
	const description = parts.join("\n\n").slice(0, MAX_DESCRIPTION).trim();
	if (!description) return null;
	const firstLine = description.split("\n").find((line) => line.trim()) ?? "";
	const title = firstLine.replace(/\s+/g, " ").trim().slice(0, Math.min(SHARED_TITLE_LENGTH, MAX_TITLE)).trim();
	return { title, description };
}

let pending: ShareDraft | null = null;

/** Keep a draft for the New card screen the person opens next. */
export function holdShareDraft(draft: ShareDraft | null): void {
	pending = draft;
}

/** The held draft, once: a second read gets nothing. */
export function takeShareDraft(): ShareDraft | null {
	const draft = pending;
	pending = null;
	return draft;
}
