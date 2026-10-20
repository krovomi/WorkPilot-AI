/**
 * Pulling finished files out of a JSON document that is still being written.
 *
 * The model answers `generate-code` with one object — `{ files: [...],
 * summary, instructions }` — and that object is only parseable once its last
 * brace arrives. Waiting for it is what made a two-minute generation look like
 * a spinner over a dead page: every file was already written, and none of them
 * could be shown.
 *
 * So the text is scanned as it accumulates. A file object is emitted the
 * moment its own braces balance, which is the earliest point at which it is
 * *true* — no half-written `content` is ever handed to the UI. The filename of
 * the object currently being written is reported separately, because knowing
 * which file the model is on is the difference between progress and a spinner.
 *
 * Nothing here replaces the final parse: `parseJsonLoose` still owns the
 * result. This is a view onto the same text while it is in flight, and a
 * provider that yields everything in one chunk simply gets one pass of it.
 */

export interface StreamedFile {
	filename: string;
	language: string;
	content: string;
}

interface ScanResult {
	/** Files whose JSON object closed since the last scan. */
	files: StreamedFile[];
	/** Filename of the object still being written, when it is already known. */
	writing: string | null;
}

/** Where the `files` array starts, or -1 while the key has not arrived yet. */
function findFilesArray(text: string): number {
	const key = /"files"\s*:\s*\[/g;
	const match = key.exec(text);
	return match ? match.index + match[0].length : -1;
}

/**
 * Walk from `start` to the end of the object that opens there, respecting
 * strings and escapes. Returns the index just past its closing brace, or -1
 * when the object has not finished arriving.
 */
function endOfObject(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

function asStreamedFile(raw: unknown): StreamedFile | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const filename = typeof record.filename === "string" ? record.filename : "";
	if (!filename.trim()) return null;
	return {
		filename,
		language: typeof record.language === "string" ? record.language : "",
		content: typeof record.content === "string" ? record.content : "",
	};
}

/**
 * Reads a growing JSON document and reports what is already complete in it.
 *
 * One instance per generation: it keeps the offset it has consumed up to, so
 * `push` costs the new text rather than a re-scan of everything received so
 * far — which on a fifty-file answer is the difference between linear and
 * quadratic work over the same bytes.
 */
export class GeneratedFileStream {
	private text = "";
	/** Offset in `text` where the next unconsumed file object may start. */
	private cursor = -1;
	private finished = false;
	private lastWriting: string | null = null;

	/** Feed a chunk; get back whatever became true because of it. */
	push(chunk: string): ScanResult {
		this.text += chunk;
		return this.scan();
	}

	/** What the scanner has emitted so far, in the order the model wrote it. */
	get writing(): string | null {
		return this.lastWriting;
	}

	private scan(): ScanResult {
		const files: StreamedFile[] = [];
		if (this.finished) return { files, writing: null };

		if (this.cursor === -1) {
			this.cursor = findFilesArray(this.text);
			if (this.cursor === -1) return { files, writing: null };
		}

		while (this.cursor < this.text.length) {
			const open = this.text.indexOf("{", this.cursor);
			if (open === -1) break;

			// A `]` before the next `{` closes the array: everything after it is
			// the summary and the instructions, which the final parse owns.
			const close = this.text.indexOf("]", this.cursor);
			if (close !== -1 && close < open) {
				this.finished = true;
				this.lastWriting = null;
				return { files, writing: null };
			}

			const end = endOfObject(this.text, open);
			if (end === -1) {
				// Still arriving. Name it if the model has got as far as the
				// filename, so the UI can say which file it is on.
				this.lastWriting = filenameOf(this.text.slice(open));
				return { files, writing: this.lastWriting };
			}

			try {
				const file = asStreamedFile(JSON.parse(this.text.slice(open, end)));
				if (file) files.push(file);
			} catch {
				// Balanced braces that are not a JSON object: the model wrote
				// something else into the array. The final parse decides what the
				// answer really was; this pass just skips it.
			}
			this.cursor = end;
			this.lastWriting = null;
		}

		return { files, writing: this.lastWriting };
	}
}

/** The `filename` of a half-written object, when it has already been written. */
function filenameOf(partialObject: string): string | null {
	const match = /"filename"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partialObject);
	if (!match) return null;
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return match[1];
	}
}
