/**
 * Les appareils personnalisés de la matrice (#383), gardés par le main.
 *
 * Le renderer décrit un appareil une fois (`readCustomDeviceDraft` : chaque
 * champ dans ses bornes, ou refus), le main lui donne un id `custom-<uuid>` et
 * l'écrit dans `<userData>/device-matrix/custom-devices.json`. Ensuite le
 * renderer le **nomme**, comme un appareil du catalogue : une capture, une
 * relecture ou un export ne reçoivent jamais une fenêtre ou un user agent.
 */
import { randomUUID } from "node:crypto";
import { findDevicePreset } from "../../shared/constants/device-presets";
import type { CustomDeviceDraft, CustomDeviceError, CustomDevicePreset } from "../../shared/types/device-library";
import type { DevicePreset } from "../../shared/types/device-matrix";
import { CUSTOM_DEVICE_LIMITS, customDevice, readStoredCustomDevice } from "../../shared/utils/custom-device";
import { readLibrary, writeLibrary } from "./library-file";

export class CustomDeviceFailure extends Error {
	constructor(readonly code: CustomDeviceError) {
		super(code);
	}
}

/** La liste en mémoire, relue une fois ; les écritures passent l'une après l'autre. */
let loaded: Promise<CustomDevicePreset[]> | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function listCustomDevices(): Promise<CustomDevicePreset[]> {
	loaded ??= readLibrary("custom-devices", readStoredCustomDevice, CUSTOM_DEVICE_LIMITS.maxDevices);
	return loaded;
}

/** Pour les tests : oublier la liste en mémoire. */
export function forgetCustomDevices(): void {
	loaded = null;
	queue = Promise.resolve();
}

function change(update: (devices: CustomDevicePreset[]) => CustomDevicePreset[]): Promise<CustomDevicePreset[]> {
	const next = queue.then(async () => {
		const devices = update(await listCustomDevices());
		try {
			await writeLibrary("custom-devices", devices);
		} catch {
			throw new CustomDeviceFailure("write-failed");
		}
		loaded = Promise.resolve(devices);
		return devices;
	});
	queue = next.catch(() => undefined);
	return next;
}

/** Ajoute un appareil déjà relu dans ses bornes ; la liste pleine refuse (`too-many`). */
export function addCustomDevice(draft: CustomDeviceDraft): Promise<CustomDevicePreset[]> {
	return change((devices) => {
		if (devices.length >= CUSTOM_DEVICE_LIMITS.maxDevices) throw new CustomDeviceFailure("too-many");
		return [...devices, customDevice(`custom-${randomUUID()}`, draft)];
	});
}

/** Retire l'appareil `id` ; un id inconnu refuse (`unknown-device`). */
export function removeCustomDevice(id: string): Promise<CustomDevicePreset[]> {
	return change((devices) => {
		if (!devices.some((device) => device.id === id)) throw new CustomDeviceFailure("unknown-device");
		return devices.filter((device) => device.id !== id);
	});
}

/** L'appareil d'un id reçu : du catalogue, sinon des appareils personnalisés ; `undefined` pour tout autre chose. */
export async function findDevice(id: unknown): Promise<DevicePreset | undefined> {
	if (typeof id !== "string") return undefined;
	return findDevicePreset(id) ?? (await listCustomDevices()).find((device) => device.id === id);
}
