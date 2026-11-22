/**
 * Les appareils personnalisés et les personas de la matrice d'appareils
 * (#383) : lister, ajouter, retirer.
 *
 * Un appareil arrive décrit, et chaque champ est relu dans ses bornes
 * (`readCustomDeviceDraft`) ; l'id vient du main. Un persona arrive avec un
 * nom seulement : le main lit les cookies de l'aperçu pour l'origine du
 * serveur qu'il a lancé, les chiffre et ne rend au renderer que le nom,
 * l'hôte, le nombre de cookies et la date. Les refus sont des codes, jamais
 * un message d'exception.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	CustomDevicePreset,
	CustomDeviceResult,
	PersonaError,
	PersonaResult,
	PersonaSummary,
} from "../../shared/types/device-library";
import {
	CUSTOM_DEVICE_ID,
	PERSONA_ID,
	readCustomDeviceDraft,
	readDisplayName,
} from "../../shared/utils/custom-device";
import { appEmulatorService } from "../app-emulator-service";
import {
	CustomDeviceFailure,
	addCustomDevice,
	listCustomDevices,
	removeCustomDevice,
} from "../device-matrix/custom-devices";
import { PersonaFailure, deletePersona, listPersonas, savePersona } from "../device-matrix/personas";

/** L'unique champ texte d'une requête (`{ id }`, `{ name }`), ou `undefined`. */
function field(raw: unknown, key: string): unknown {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
}

async function devices(work: () => Promise<readonly CustomDevicePreset[]>): Promise<CustomDeviceResult> {
	try {
		return { success: true, data: await work() };
	} catch (error: unknown) {
		return { success: false, error: error instanceof CustomDeviceFailure ? error.code : "write-failed" };
	}
}

async function personas(work: () => Promise<readonly PersonaSummary[]>): Promise<PersonaResult> {
	try {
		return { success: true, data: await work() };
	} catch (error: unknown) {
		// Enregistrer et retirer ne lèvent que des `PersonaError` (les codes de rejeu viennent de `personaCookies`).
		return { success: false, error: error instanceof PersonaFailure ? (error.code as PersonaError) : "write-failed" };
	}
}

/** L'origine `http(s)` du serveur de l'émulateur, ou `null`. */
export function httpOrigin(serverUrl: string): string | null {
	try {
		const url = new URL(serverUrl);
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
	} catch {
		return null;
	}
}

export function registerDeviceLibraryHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_LIST_CUSTOM_DEVICES, () => devices(listCustomDevices));

	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE, (_event, raw: unknown): Promise<CustomDeviceResult> => {
		const draft = readCustomDeviceDraft(raw);
		if (!draft) return Promise.resolve({ success: false, error: "invalid-device" });
		return devices(() => addCustomDevice(draft));
	});

	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_DELETE_CUSTOM_DEVICE,
		(_event, raw: unknown): Promise<CustomDeviceResult> => {
			const id = field(raw, "id");
			if (typeof id !== "string" || !CUSTOM_DEVICE_ID.test(id)) {
				return Promise.resolve({ success: false, error: "invalid-request" });
			}
			return devices(() => removeCustomDevice(id));
		},
	);

	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_LIST_PERSONAS, () => personas(listPersonas));

	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, (_event, raw: unknown): Promise<PersonaResult> => {
		const name = readDisplayName(field(raw, "name"));
		if (name === null) return Promise.resolve({ success: false, error: "invalid-request" });
		const serverUrl = appEmulatorService.getUrl();
		if (!serverUrl) return Promise.resolve({ success: false, error: "not-running" });
		const origin = httpOrigin(serverUrl);
		if (!origin) return Promise.resolve({ success: false, error: "not-running" });
		return personas(() => savePersona(name, origin));
	});

	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_DELETE_PERSONA, (_event, raw: unknown): Promise<PersonaResult> => {
		const id = field(raw, "id");
		if (typeof id !== "string" || !PERSONA_ID.test(id)) {
			return Promise.resolve({ success: false, error: "invalid-request" });
		}
		return personas(() => deletePersona(id));
	});
}
