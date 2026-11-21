/**
 * The source files of a package archive, read in memory (issue #369, lot 3).
 *
 * A gzip'd tar (npm tarball, PyPI sdist) or a zip (PyPI wheel), as the
 * registry publishes it. Nothing is written to disk, so no entry name ever
 * becomes a path; entries are only read when `sourceLanguage` says they are
 * code worth scanning. Bounded: the archive is inflated to at most
 * `MAX_UNPACKED_BYTES`, a file over `MAX_SOURCE_BYTES` and the files after
 * `MAX_SOURCE_FILES` are skipped (the scan says it is partial). A zip
 * entry's inflated size is bounded too, whatever its header claims.
 */

import * as zlib from "node:zlib";
import { sourceLanguage } from "../../shared/mcp-catalog/code-scan";

export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_SOURCE_FILES = 3_000;

export interface SourceFile {
	path: string;
	text: string;
}

export interface SourceFiles {
	files: SourceFile[];
	skipped: number;
}

/** An archive that cannot be read as one; `tooLarge` is said apart. */
export class ArchiveError extends Error {
	constructor(readonly code: "tooLarge" | "unsupported") {
		super(code);
	}
}

class Collector {
	readonly files: SourceFile[] = [];
	skipped = 0;

	/** Whether an entry named `name`, of `size` bytes, is to be read. */
	wants(name: string, size: number): boolean {
		if (!sourceLanguage(name)) return false;
		if (size > MAX_SOURCE_BYTES || this.files.length >= MAX_SOURCE_FILES) {
			this.skipped++;
			return false;
		}
		return true;
	}

	add(name: string, data: Buffer): void {
		this.files.push({ path: name, text: data.toString("utf-8") });
	}
}

/** The entry name without its top folder (`package/`, `name-1.0/`). */
function withoutTop(name: string): string {
	const slash = name.indexOf("/");
	return slash >= 0 ? name.slice(slash + 1) : name;
}

function cString(buffer: Buffer, start: number, length: number): string {
	const slice = buffer.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end < 0 ? slice.length : end).toString("utf-8");
}

function octal(buffer: Buffer, start: number, length: number): number {
	const value = cString(buffer, start, length).trim();
	if (!/^[0-7]*$/.test(value)) throw new ArchiveError("unsupported");
	return value ? Number.parseInt(value, 8) : 0;
}

/** The `path` record of a pax header, if it has one. */
function paxPath(data: Buffer): string | undefined {
	for (const record of data.toString("utf-8").split("\n")) {
		const match = /^\d+ path=(.*)$/.exec(record);
		if (match) return match[1];
	}
	return undefined;
}

function gunzip(archive: Buffer): Buffer {
	try {
		return zlib.gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
			throw new ArchiveError("tooLarge");
		}
		throw new ArchiveError("unsupported");
	}
}

/** `read`, any failure that is not already an `ArchiveError` made `unsupported`. */
function guarded(read: () => SourceFiles): SourceFiles {
	try {
		return read();
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError("unsupported");
	}
}

/** The source files of a `.tar.gz`. */
export function readTarGz(archive: Buffer): SourceFiles {
	return guarded(() => tarEntries(archive));
}

function tarEntries(archive: Buffer): SourceFiles {
	const tar = gunzip(archive);
	const out = new Collector();
	let offset = 0;
	let longName: string | undefined;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] || 48);
		const prefix = cString(header, 345, 155);
		const base = cString(header, 0, 100);
		const name = longName ?? (prefix ? `${prefix}/${base}` : base);
		const start = offset + 512;
		const end = start + size;
		if (end > tar.length) throw new ArchiveError("unsupported");
		const data = tar.subarray(start, end);
		longName = undefined;
		if (type === "x") longName = paxPath(data);
		else if (type === "L") longName = cString(data, 0, data.length);
		else if (type === "0" || type === "7") {
			const file = withoutTop(name);
			if (out.wants(file, size)) out.add(file, data);
		}
		offset = start + Math.ceil(size / 512) * 512;
	}
	return { files: out.files, skipped: out.skipped };
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEndOfDirectory(zip: Buffer): number {
	const stop = Math.max(0, zip.length - 22 - 0xffff);
	for (let i = zip.length - 22; i >= stop; i--) {
		if (zip.readUInt32LE(i) === EOCD) return i;
	}
	throw new ArchiveError("unsupported");
}

function inflateEntry(zip: Buffer, method: number, start: number, length: number): Buffer {
	const raw = zip.subarray(start, start + length);
	if (method === 0) {
		if (raw.length > MAX_SOURCE_BYTES) throw new ArchiveError("unsupported");
		return raw;
	}
	if (method !== 8) throw new ArchiveError("unsupported");
	try {
		return zlib.inflateRawSync(raw, { maxOutputLength: MAX_SOURCE_BYTES });
	} catch {
		throw new ArchiveError("unsupported");
	}
}

/** The source files of a `.zip` (a wheel). Zip64 is not read. */
export function readZip(zip: Buffer): SourceFiles {
	return guarded(() => zipEntries(zip));
}

function zipEntries(zip: Buffer): SourceFiles {
	if (zip.length < 22) throw new ArchiveError("unsupported");
	const end = findEndOfDirectory(zip);
	const count = zip.readUInt16LE(end + 10);
	let offset = zip.readUInt32LE(end + 16);
	const out = new Collector();
	let unpacked = 0;
	for (let i = 0; i < count; i++) {
		if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL) {
			throw new ArchiveError("unsupported");
		}
		const method = zip.readUInt16LE(offset + 10);
		const packed = zip.readUInt32LE(offset + 20);
		const size = zip.readUInt32LE(offset + 24);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const local = zip.readUInt32LE(offset + 42);
		const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf-8");
		offset += 46 + nameLength + extraLength + commentLength;
		if (!out.wants(name, size)) continue;
		if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL) {
			throw new ArchiveError("unsupported");
		}
		const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		if (dataStart + packed > zip.length) throw new ArchiveError("unsupported");
		const data = inflateEntry(zip, method, dataStart, packed);
		unpacked += data.length;
		if (unpacked > MAX_UNPACKED_BYTES) throw new ArchiveError("tooLarge");
		out.add(name, data);
	}
	return { files: out.files, skipped: out.skipped };
}
