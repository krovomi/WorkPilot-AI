/**
 * Package archives built in memory for the code-scan tests: tar (with ustar
 * prefixes, pax and GNU long names) and zip (stored or deflated).
 */
import * as zlib from "node:zlib";

export interface TarEntry {
	name: string;
	body?: string | Buffer;
	/** Type flag; "" writes a NUL, as old tars do. */
	type?: string;
	/** ustar prefix field. */
	prefix?: string;
	/** Raw size field, to write a broken header. */
	sizeField?: string;
}

function header(entry: TarEntry, size: number): Buffer {
	const block = Buffer.alloc(512);
	block.write(entry.name, 0, 100, "utf-8");
	block.write(entry.sizeField ?? size.toString(8).padStart(11, "0"), 124, 12, "ascii");
	const type = entry.type ?? "0";
	if (type) block.write(type, 156, 1, "ascii");
	if (entry.prefix) block.write(entry.prefix, 345, 155, "utf-8");
	return block;
}

export function tar(entries: TarEntry[], { end = true } = {}): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "");
		parts.push(header(entry, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	if (end) parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

export function tgz(entries: TarEntry[], options?: { end?: boolean }): Buffer {
	return zlib.gzipSync(tar(entries, options));
}

/** A pax record: `<length> path=<value>\n`, the length counting itself. */
export function paxRecord(value: string): string {
	const rest = ` path=${value}\n`;
	let length = rest.length + 1;
	while (`${length}${rest}`.length !== length) length++;
	return `${length}${rest}`;
}

export interface ZipEntry {
	name: string;
	body: string | Buffer;
	method?: 0 | 8 | 12;
	/** Size field of the central record, to lie about it. */
	sizeField?: number;
	/** Local header offset, to point it elsewhere. */
	localOffset?: number;
}

export function zip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const raw = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body);
		const method = entry.method ?? 8;
		const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
		const name = Buffer.from(entry.name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE(method, 10);
		record.writeUInt32LE(data.length, 20);
		record.writeUInt32LE(entry.sizeField ?? raw.length, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt32LE(entry.localOffset ?? offset, 42);
		locals.push(local, name, data);
		central.push(record, name);
		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
