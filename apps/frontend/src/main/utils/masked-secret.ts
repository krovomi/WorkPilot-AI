/**
 * The two directions of MASKED_SECRET (shared/constants/secrets.ts): what the
 * main process hands the renderer in place of a stored secret, and what a
 * value sent back by the renderer means. The renderer is not trusted (rule
 * S6): it learns that a secret is set, never its value.
 */
import { MASKED_SECRET, MASKED_SECRET_CHAR } from "../../shared/constants";

/** `value` as the renderer may see it: the mask when set, unchanged when empty. */
export function maskSecret<T extends string | undefined | null>(
	value: T,
): T | string {
	return value ? MASKED_SECRET : value;
}

/**
 * What a secret sent back by the renderer means: undefined (keep the stored
 * value) for the mask, or the text typed after or around it.
 */
export function unmaskSecret(value: string | undefined): string | undefined {
	if (typeof value !== "string" || !value.includes(MASKED_SECRET_CHAR)) {
		return value;
	}
	const typed = value.replaceAll(MASKED_SECRET_CHAR, "");
	return typed === "" ? undefined : typed;
}

/**
 * The same URL for a stored secret: a secret kept behind the mask only goes
 * back to the host it was saved for, never to one the renderer names.
 */
export function sameEndpoint(a: string | undefined, b: string | undefined): boolean {
	const normalize = (url: string | undefined) =>
		(url ?? "").trim().replace(/\/+$/, "").toLowerCase();
	return normalize(a) === normalize(b);
}
