/**
 * Read or rewrite a file that may not exist, without checking first.
 *
 * `if (existsSync(p)) writeFileSync(p, …)` leaves a window between the check
 * and the write in which the path can be replaced (a link, another file):
 * the write then lands where the check never looked. Opening the file once and
 * working on that descriptor closes the window, and "missing" is the open
 * failing with ENOENT rather than a separate question.
 */

import {
	closeSync,
	ftruncateSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** The file's text, or `null` when it does not exist. Other errors are thrown. */
export function readIfExists(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

/**
 * Rewrite an existing file through one descriptor: `update` receives its text
 * and returns the new text, or `null` to leave it as it is.
 *
 * Returns `false` when the file does not exist (nothing is created), `true`
 * otherwise. Other errors, including those thrown by `update`, are thrown.
 */
export function updateExistingFile(
	filePath: string,
	update: (text: string) => string | null,
): boolean {
	let fd: number;
	try {
		fd = openSync(filePath, "r+");
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	try {
		const next = update(readFileSync(fd, "utf-8"));
		if (next !== null) {
			ftruncateSync(fd, 0);
			writeSync(fd, next, 0, "utf-8");
		}
		return true;
	} finally {
		closeSync(fd);
	}
}
