/**
 * Les légendes de la grille exportée (#383), écrites par le main dans la
 * langue de l'app à partir des mêmes textes que le renderer
 * (`appEmulator:devices.*`, `appEmulator:matrix.*`) : le renderer ne fournit
 * aucun texte dessiné dans l'image.
 */
import en from "../../shared/i18n/locales/en/appEmulator.json";
import fr from "../../shared/i18n/locales/fr/appEmulator.json";
import { isRotated, orientationOf } from "../../shared/constants/device-presets";
import type { CpuProfile, DevicePreset, NetworkProfile } from "../../shared/types/device-matrix";

type Texts = typeof en;

function texts(language: string): Texts {
	return language === "fr" ? fr : en;
}

/** `{{nom}}` remplacé par sa valeur, comme l'interpolation d'i18next (les gabarits sont les nôtres). */
function interpolate(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values[key]));
}

export interface GridCaption {
	readonly label: string;
	readonly detail: string;
}

/** Le nom de l'appareil, puis sa fenêtre, son sens s'il a été tourné, et le bridage appliqué s'il y en a un. */
export function gridCaption(
	device: DevicePreset,
	network: NetworkProfile,
	cpu: CpuProfile,
	language: string,
): GridCaption {
	const { devices, matrix } = texts(language);
	const parts = [
		interpolate(matrix.dimensions, {
			width: device.width,
			height: device.height,
			dpr: device.deviceScaleFactor,
		}),
	];
	if (isRotated(device)) parts.push(matrix.orientation[orientationOf(device)]);
	if (network.conditions) parts.push(matrix.network[network.id]);
	if (cpu.rate > 1) parts.push(interpolate(matrix.cpuSlowdown, { rate: cpu.rate }));
	return {
		label: (devices as Record<string, string>)[device.id] ?? device.id,
		detail: parts.join(" · "),
	};
}
