import { app, safeStorage } from "electron";
import { join } from "node:path";
import { JevSecretStore } from "./secret-store";
let service: JevSecretStore | undefined;
export function getJevService(): JevSecretStore {
	service ??= new JevSecretStore(
		join(app.getPath("userData"), "jev-secret.json"),
		safeStorage,
	);
	return service;
}
