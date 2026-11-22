/**
 * Les appareils personnalisés et les personas de la matrice (#383), tels que
 * le main les garde : le renderer ne fait que les afficher et demander un
 * ajout ou un retrait. Un persona n'arrive ici que par son nom, son hôte, son
 * nombre de cookies et sa date.
 */
import { create } from "zustand";
import type {
	CustomDeviceDraft,
	CustomDeviceError,
	CustomDevicePreset,
	CustomDeviceResult,
	PersonaError,
	PersonaResult,
	PersonaSummary,
} from "../../shared/types/device-library";

export type DeviceLibraryProblem =
	| { readonly scope: "device"; readonly error: CustomDeviceError }
	| { readonly scope: "persona"; readonly error: PersonaError };

interface DeviceLibraryState {
	customDevices: readonly CustomDevicePreset[];
	personas: readonly PersonaSummary[];
	loaded: boolean;
	saving: boolean;
	/** Le dernier refus du main, effacé à l'opération suivante. */
	problem: DeviceLibraryProblem | null;
	load: () => Promise<void>;
	/** `true` quand le main a gardé l'appareil. */
	addDevice: (draft: CustomDeviceDraft) => Promise<boolean>;
	removeDevice: (id: string) => Promise<void>;
	/** Enregistre la session de l'aperçu sous ce nom ; rend l'id du persona créé, ou `null`. */
	savePersona: (name: string) => Promise<string | null>;
	deletePersona: (id: string) => Promise<void>;
}

const api = () => globalThis.electronAPI;

/** Le résultat d'un appel, ou `null` s'il échoue de quelque façon que ce soit. */
async function quietly<T>(call: () => Promise<T>): Promise<T | null> {
	try {
		return await call();
	} catch {
		return null;
	}
}

export const useDeviceLibraryStore = create<DeviceLibraryState>((set, get) => {
	async function devices(call: () => Promise<CustomDeviceResult>): Promise<boolean> {
		set({ saving: true, problem: null });
		let result: CustomDeviceResult;
		try {
			result = await call();
		} catch {
			result = { success: false, error: "write-failed" };
		}
		if (result.success) set({ saving: false, customDevices: result.data });
		else set({ saving: false, problem: { scope: "device", error: result.error } });
		return result.success;
	}

	async function personas(call: () => Promise<PersonaResult>): Promise<readonly PersonaSummary[] | null> {
		set({ saving: true, problem: null });
		let result: PersonaResult;
		try {
			result = await call();
		} catch {
			result = { success: false, error: "write-failed" };
		}
		if (result.success) {
			set({ saving: false, personas: result.data });
			return result.data;
		}
		set({ saving: false, problem: { scope: "persona", error: result.error } });
		return null;
	}

	return {
		customDevices: [],
		personas: [],
		loaded: false,
		saving: false,
		problem: null,

		// Lire ne refuse rien à la personne : une liste illisible reste vide, sans message.
		load: async () => {
			if (get().loaded) return;
			set({ loaded: true });
			const [deviceList, personaList] = await Promise.all([
				quietly(() => api().listEmulatorCustomDevices()),
				quietly(() => api().listEmulatorPersonas()),
			]);
			if (deviceList?.success) set({ customDevices: deviceList.data });
			if (personaList?.success) set({ personas: personaList.data });
		},

		addDevice: (draft) => devices(() => api().saveEmulatorCustomDevice(draft)),

		removeDevice: async (id) => {
			await devices(() => api().deleteEmulatorCustomDevice(id));
		},

		savePersona: async (name) => {
			const before = new Set(get().personas.map((persona) => persona.id));
			const after = await personas(() => api().saveEmulatorPersona(name));
			return after?.find((persona) => !before.has(persona.id))?.id ?? null;
		},

		deletePersona: async (id) => {
			await personas(() => api().deleteEmulatorPersona(id));
		},
	};
});
