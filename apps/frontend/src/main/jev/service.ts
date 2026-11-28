import { app } from "electron";
import { join } from "node:path";
import { guardedSafeStorage } from "../secret-storage";
import { JevSecretStore } from "./secret-store";
let service: JevSecretStore | undefined;
export function getJevService(): JevSecretStore {
	service ??= new JevSecretStore(
		join(app.getPath("userData"), "jev-secret.json"),
		guardedSafeStorage,
	);
	return service;
}
