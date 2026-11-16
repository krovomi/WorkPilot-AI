/**
 * La matrice d'appareils de l'émulateur (#383) : les appareils cochés et ce
 * que chacun a rendu.
 *
 * Le lot tourne ici plutôt que dans le composant : l'onglet Émulateur est
 * démonté dès qu'on en regarde un autre, et une capture lancée doit encore
 * avoir où ranger son image au retour. Les appareils sont capturés l'un
 * après l'autre (une fenêtre cachée à la fois), dans l'ordre du catalogue.
 */
import { create } from "zustand";
import { DEFAULT_MATRIX_DEVICE_IDS, DEVICE_PRESETS } from "../../shared/constants/device-presets";
import type { DeviceCapture, DeviceCaptureError } from "../../shared/types/device-matrix";

export type DeviceCaptureEntry =
	| { readonly status: "pending" }
	| { readonly status: "capturing" }
	| { readonly status: "done"; readonly capture: DeviceCapture }
	| { readonly status: "failed"; readonly error: DeviceCaptureError };

interface DeviceMatrixState {
	selected: string[];
	entries: Record<string, DeviceCaptureEntry>;
	running: boolean;
	stopRequested: boolean;
	toggleDevice: (id: string) => void;
	setSelection: (ids: readonly string[]) => void;
	captureSelected: (path: string) => Promise<void>;
	stop: () => void;
	clear: () => void;
}

/** Les ids connus, dans l'ordre du catalogue. */
function inCatalogOrder(ids: Iterable<string>): string[] {
	const wanted = new Set(ids);
	return DEVICE_PRESETS.filter((device) => wanted.has(device.id)).map((device) => device.id);
}

export const useDeviceMatrixStore = create<DeviceMatrixState>((set, get) => ({
	selected: [...DEFAULT_MATRIX_DEVICE_IDS],
	entries: {},
	running: false,
	stopRequested: false,

	toggleDevice: (id) =>
		set((state) => {
			const next = new Set(state.selected);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return { selected: inCatalogOrder(next) };
		}),

	setSelection: (ids) => set({ selected: inCatalogOrder(ids) }),

	captureSelected: async (path) => {
		const { running, selected } = get();
		if (running || selected.length === 0) return;
		const queue = [...selected];
		const entries: Record<string, DeviceCaptureEntry> = {};
		for (const id of queue) entries[id] = { status: "pending" };
		set({ running: true, stopRequested: false, entries });
		for (const deviceId of queue) {
			if (get().stopRequested) break;
			setEntry(set, deviceId, { status: "capturing" });
			let entry: DeviceCaptureEntry;
			try {
				const result = await globalThis.electronAPI.captureEmulatorDevice({ deviceId, path });
				entry = result.success
					? { status: "done", capture: result.data }
					: { status: "failed", error: result.error };
			} catch {
				entry = { status: "failed", error: "capture-failed" };
			}
			setEntry(set, deviceId, entry);
		}
		set((state) => ({
			running: false,
			stopRequested: false,
			// Arrêté en route : ce qui n'a pas été rendu disparaît de la grille.
			entries: Object.fromEntries(
				Object.entries(state.entries).filter(([, entry]) => entry.status !== "pending"),
			),
		}));
	},

	stop: () => {
		if (get().running) set({ stopRequested: true });
	},

	clear: () => {
		if (!get().running) set({ entries: {} });
	},
}));

function setEntry(
	set: (update: (state: DeviceMatrixState) => Partial<DeviceMatrixState>) => void,
	deviceId: string,
	entry: DeviceCaptureEntry,
): void {
	set((state) => ({ entries: { ...state.entries, [deviceId]: entry } }));
}
