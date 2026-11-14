/**
 * The short subject a generated-code card is named after.
 *
 * The page hands over what it worked on: a file, a module, the first line of
 * a description. A file is named by its own name, never its absolute path:
 * the path told nothing the project did not already say, and once cut to fit
 * the title it stopped before the file name ("Tests générés :
 * /home/me/repositories/perso/IA - LLM …"). A path is still a path when a
 * folder name has spaces in it, and a Windows path is split on its own
 * separator whatever this computer's is.
 */

const MAX_SUBJECT = 40;

/** Whether `text` names a file or folder rather than saying something. */
export function looksLikePath(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) return false;
	// Absolute on POSIX, a Windows drive or a UNC share: spaces allowed.
	if (/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(trimmed)) return true;
	// Relative: only a single token with a separator, so a sentence such as
	// "log in/log out from the header" stays a sentence.
	return /[\\/]/.test(trimmed) && !/\s/.test(trimmed);
}

/** The last segment of a path, on either separator. */
export function pathLeaf(text: string): string {
	const parts = text.trim().split(/[\\/]+/).filter(Boolean);
	return parts.at(-1) ?? text.trim();
}

/** A short subject for a card title: the file name, or the start of a sentence. */
export function reviewSubject(text: string, max = MAX_SUBJECT): string {
	const trimmed = text.trim();
	const flat = (looksLikePath(trimmed) ? pathLeaf(trimmed) : trimmed).replace(/\s+/g, " ");
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
