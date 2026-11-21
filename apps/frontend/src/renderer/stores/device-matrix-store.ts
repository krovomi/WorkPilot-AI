/**
 * La matrice d'appareils de l'émulateur (#383) : les appareils cochés et ce
 * que chacun a rendu.
 *
 * Le lot tourne ici plutôt que dans le composant : l'onglet Émulateur est
 * démonté dès qu'on en regarde un autre, et une capture lancée doit encore
 * avoir où ranger son image au retour. Les appareils sont capturés l'un
 * après l'autre (une fenêtre cachée à la fois), dans l'ordre du catalogue,
 * sous les profils de bridage, le sens et la session choisis. L'export nomme
 * les appareils rendus : le main assemble ses propres captures.
 *
 * `autoCapture` est la matrice d'office de la revue d'une carte du Kanban :
 * une fois par clé (une tâche) et par session de l'app, les appareils par
 * défaut sont capturés sans qu'on le demande.
 */
import { create } from "zustand";
import { DEFAULT_MATRIX_DEVICE_IDS, DEVICE_PRESETS } from "../../shared/constants/device-presets";
import { DEFAULT_CPU_PROFILE_ID, DEFAULT_NETWORK_PROFILE_ID } from "../../shared/constants/emulation-throttling";
import type {
	CpuProfileId,
	DeviceCapture,
	DeviceCaptureError,
	DeviceGridExportError,
	DeviceGridExportFormat,
	DeviceOrientation,
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
	orientation: DeviceOrientation;
	/** Prêter aux captures la session (les cookies) de l'aperçu. */
	previewSession: boolean;
	/** Encadrer les éléments fautifs sur les captures et dans l'export. */
	showMarkers: boolean;
	/** Les clés déjà capturées d'office (`autoCapture`). */
	autoCaptured: string[];
	exporting: boolean;
	/** Le résultat du dernier export ; `null` avant, ou quand la personne a annulé. */
	exportStatus: DeviceGridExportStatus | null;
	toggleDevice: (id: string) => void;
	setSelection: (ids: readonly string[]) => void;
	setNetwork: (id: NetworkProfileId) => void;
	setCpu: (id: CpuProfileId) => void;
	setOrientation: (orientation: DeviceOrientation) => void;
	setPreviewSession: (enabled: boolean) => void;
	setShowMarkers: (enabled: boolean) => void;
	/** Capture la sélection, ou les appareils `ids` quand ils sont donnés. */
	captureSelected: (path: string, ids?: readonly string[]) => Promise<void>;
	/** Capture les appareils par défaut une seule fois par `key` ; `false` si c'est déjà fait ou impossible. */
	autoCapture: (key: string, path: string) => boolean;
	stop: () => void;
	clear: () => void;
	exportGrid: (format: DeviceGridExportFormat) => Promise<void>;
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
	orientation: "portrait",
	previewSession: false,
	showMarkers: true,
	autoCaptured: [],
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

	setOrientation: (orientation) => set({ orientation }),

	setPreviewSession: (previewSession) => set({ previewSession }),

	setShowMarkers: (showMarkers) => set({ showMarkers }),

	captureSelected: async (path, ids) => {
		const { running, exporting, selected, network, cpu, orientation, previewSession } = get();
		const queue = ids ? inCatalogOrder(ids) : [...selected];
		if (running || exporting || queue.length === 0) return;
		const entries: Record<string, DeviceCaptureEntry> = {};
		for (const id of queue) entries[id] = { status: "pending" };
		set({ running: true, stopRequested: false, entries, exportStatus: null });
		for (const deviceId of queue) {
			if (get().stopRequested) break;
			setEntry(set, deviceId, { status: "capturing" });
			let entry: DeviceCaptureEntry;
			try {
				const result = await globalThis.electronAPI.captureEmulatorDevice({
					deviceId,
					path,
					network,
					cpu,
					orientation,
					previewSession,
				});
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

	autoCapture: (key, path) => {
		const { running, exporting, autoCaptured } = get();
		if (running || exporting || autoCaptured.includes(key)) return false;
		set({ autoCaptured: [...autoCaptured, key] });
		void get().captureSelected(path, DEFAULT_MATRIX_DEVICE_IDS);
		return true;
	},

	stop: () => {
		if (get().running) set({ stopRequested: true });
	},

	clear: () => {
		if (!get().running) set({ entries: {}, exportStatus: null });
	},

	exportGrid: async (format) => {
		const { running, exporting, entries, showMarkers } = get();
		const deviceIds = DEVICE_PRESETS.filter((device) => entries[device.id]?.status === "done").map(
			(device) => device.id,
		);
		if (running || exporting || deviceIds.length === 0) return;
		set({ exporting: true, exportStatus: null });
		let exportStatus: DeviceGridExportStatus | null;
		try {
			const result = await globalThis.electronAPI.exportEmulatorDeviceGrid({
				deviceIds,
				format,
				markers: showMarkers,
			});
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
