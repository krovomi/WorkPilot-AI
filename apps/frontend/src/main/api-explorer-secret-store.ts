import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface ApiExplorerSecretValues {
	bearer?: string;
	password?: string;
	keyValue?: string;
	oauth2ClientSecret?: string;
	oauth2AccessToken?: string;
	environmentToken?: string;
}

interface SafeStorageAdapter {
	isEncryptionAvailable(): boolean;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
}

export class ApiExplorerSecretStore {
	constructor(
		private readonly filePath: string,
		private readonly crypto: SafeStorageAdapter,
	) {}

	load(scope: string): ApiExplorerSecretValues {
		if (!this.crypto.isEncryptionAvailable()) return {};
		const entries = this.readEntries();
		const encrypted = entries[scope];
		if (!encrypted) return {};
		try {
			const plaintext = this.crypto.decryptString(
				Buffer.from(encrypted, "base64"),
			);
			return JSON.parse(plaintext) as ApiExplorerSecretValues;
		} catch {
			return {};
		}
	}

	save(scope: string, values: ApiExplorerSecretValues): void {
		if (!this.crypto.isEncryptionAvailable()) {
			throw new Error("OS encryption is unavailable");
		}
		const entries = this.readEntries();
		entries[scope] = this.crypto
			.encryptString(JSON.stringify(values))
			.toString("base64");
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify(entries), {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporaryPath, this.filePath);
	}

	private readEntries(): Record<string, string> {
		if (!existsSync(this.filePath)) return {};
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
			return parsed && typeof parsed === "object"
				? (parsed as Record<string, string>)
				: {};
		} catch {
			return {};
		}
	}
}
