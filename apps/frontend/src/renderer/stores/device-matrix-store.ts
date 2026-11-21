/**
 * La matrice d'appareils de l'émulateur (#383) : les appareils cochés et ce
 * que chacun a rendu.
 *
 * Le lot tourne ici plutôt que dans le composant : l'onglet Émulateur est
 * démonté dès qu'on en regarde un autre, et une capture lancée doit encore
 * avoir où ranger son image au retour. Les appareils sont capturés l'un
 * après l'autre (une fenêtre cachée à la fois), dans l'ordre du catalogue,
 * sous les profils de bridage choisis. L'export nomme les appareils rendus :
 * le main assemble ses propres captures.
 */
import { create } from "zustand";
import { DEFAULT_MATRIX_DEVICE_IDS, DEVICE_PRESETS } from "../../shared/constants/device-presets";
import { DEFAULT_CPU_PROFILE_ID, DEFAULT_NETWORK_PROFILE_ID } from "../../shared/constants/emulation-throttling";
import type {
	CpuProfileId,
	DeviceCapture,
	DeviceCaptureError,
	DeviceGridExportError,
	NetworkProfileId,
} from "../../shared/types/device-matrix";

export type DeviceCaptureEntry =
	| { readonly status: "pending" }
	| { readonly status: "capturing" }
	| { readonly status: "done"; readonly capture: DeviceCapture }
	| { readonly status: "failed"; readonly error: DeviceCaptureError };

export type DeviceGridExportStatus =
	| { readonly status: "saved"; readonly fileName: string }
	| { readonly status: "failed"; readonly error: DeviceGridExportError };

interface DeviceMatrixState {
	selected: string[];
	entries: Record<string, DeviceCaptureEntry>;
	running: boolean;
	stopRequested: boolean;
	network: NetworkProfileId;
	cpu: CpuProfileId;
	exporting: boolean;
	/** Le résultat du dernier export ; `null` avant, ou quand la personne a annulé. */
	exportStatus: DeviceGridExportStatus | null;
	toggleDevice: (id: string) => void;
	setSelection: (ids: readonly string[]) => void;
	setNetwork: (id: NetworkProfileId) => void;
	setCpu: (id: CpuProfileId) => void;
	captureSelected: (path: string) => Promise<void>;
	stop: () => void;
	clear: () => void;
	exportGrid: () => Promise<void>;
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
	network: DEFAULT_NETWORK_PROFILE_ID,
	cpu: DEFAULT_CPU_PROFILE_ID,
	exporting: false,
	exportStatus: null,

	toggleDevice: (id) =>
		set((state) => {
			const next = new Set(state.selected);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return { selected: inCatalogOrder(next) };
		}),

	setSelection: (ids) => set({ selected: inCatalogOrder(ids) }),

	setNetwork: (network) => set({ network }),

	setCpu: (cpu) => set({ cpu }),

	captureSelected: async (path) => {
		const { running, exporting, selected, network, cpu } = get();
		if (running || exporting || selected.length === 0) return;
		const queue = [...selected];
		const entries: Record<string, DeviceCaptureEntry> = {};
		for (const id of queue) entries[id] = { status: "pending" };
		set({ running: true, stopRequested: false, entries, exportStatus: null });
		for (const deviceId of queue) {
			if (get().stopRequested) break;
			setEntry(set, deviceId, { status: "capturing" });
			let entry: DeviceCaptureEntry;
			try {
				const result = await globalThis.electronAPI.captureEmulatorDevice({ deviceId, path, network, cpu });
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
		if (!get().running) set({ entries: {}, exportStatus: null });
	},

	exportGrid: async () => {
		const { running, exporting, entries } = get();
		const deviceIds = DEVICE_PRESETS.filter((device) => entries[device.id]?.status === "done").map(
			(device) => device.id,
		);
		if (running || exporting || deviceIds.length === 0) return;
		set({ exporting: true, exportStatus: null });
		let exportStatus: DeviceGridExportStatus | null;
		try {
			const result = await globalThis.electronAPI.exportEmulatorDeviceGrid({ deviceIds });
			if (!result.success) exportStatus = { status: "failed", error: result.error };
			else exportStatus = result.data.saved ? { status: "saved", fileName: result.data.fileName } : null;
		} catch {
			exportStatus = { status: "failed", error: "export-failed" };
		}
		set({ exporting: false, exportStatus });
	},
}));

function setEntry(
	set: (update: (state: DeviceMatrixState) => Partial<DeviceMatrixState>) => void,
	deviceId: string,
	entry: DeviceCaptureEntry,
): void {
	set((state) => ({ entries: { ...state.entries, [deviceId]: entry } }));
}
