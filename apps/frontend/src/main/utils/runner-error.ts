/**
 * The message of a runner's `<PREFIX>_ERROR:` line.
 *
 * The Python runners print it as a JSON string (`_emit(prefix, str(exc))`),
 * which keeps a message with a newline on one line; a few print it as plain
 * text. Shown as it arrives, the JSON form reads `"Project path does not
 * exist: …"`, quotes and escapes included.
 */
export function decodeRunnerError(raw: string): string {
	if (raw.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(raw);
			if (typeof decoded === "string") return decoded;
		} catch {
			/* not JSON after all */
		}
	}
	return raw;
}
