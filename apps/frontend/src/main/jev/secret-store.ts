import { randomUUID } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import type { JevCredentialStatus } from "../../shared/types/jev";
interface Crypto {
	isEncryptionAvailable(): boolean;
	getSelectedStorageBackend?(): string;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
}
export class JevSecretStore {
	constructor(
		private readonly path: string,
		private readonly crypto: Crypto,
	) {}
	private available(): boolean {
		try {
			return (
				this.crypto.isEncryptionAvailable() &&
				this.crypto.getSelectedStorageBackend?.() !== "basic_text"
			);
		} catch {
			return false;
		}
	}
	getStatus(): JevCredentialStatus {
		return {
			configured: !!this.read(),
			secureStorageAvailable: this.available(),
		};
	}
	read(): string | undefined {
		if (!this.available()) return undefined;
		try {
			const raw = readFileSync(this.path, "utf8");
			if (raw.length > 32768) return undefined;
			const data = JSON.parse(raw);
			if (data.version !== 1 || typeof data.encrypted !== "string")
				return undefined;
			const value = this.crypto.decryptString(
				Buffer.from(data.encrypted, "base64"),
			);
			return value &&
				value.length <= 4096 &&
				!Array.from(value).some(
					(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
				)
				? value
				: undefined;
		} catch {
			return undefined;
		}
	}
	save(key: string): void {
		if (
			typeof key !== "string" ||
			!key.trim() ||
			key.length > 4096 ||
			Array.from(key).some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
			)
		)
			throw new Error("jev-invalid-key");
		if (!this.available()) throw new Error("jev-storage-unavailable");
		const data = JSON.stringify({
			version: 1,
			encrypted: this.crypto.encryptString(key.trim()).toString("base64"),
		});
		const temp = this.path + "." + randomUUID();
		mkdirSync(dirname(this.path), { recursive: true });
		try {
			writeFileSync(temp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
			renameSync(temp, this.path);
		} finally {
			try {
				unlinkSync(temp);
			} catch {
				/* The rename consumed the temporary file, or cleanup is unavailable. */
			}
		}
	}
	clear(): void {
		try {
			unlinkSync(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("jev-clear-failed");
		}
	}
}
