/**
 * Les repères des éléments fautifs sur une capture de la matrice (#383).
 *
 * Le rapport situe chaque exemple en pixels CSS de la page ; la capture ne
 * montre que la fenêtre. Un repère est la part de la fenêtre que la boîte
 * occupe (de 0 à 1), coupée à ses bords : le renderer le pose en pourcentage
 * sur l'image affichée, le main le dessine sur la grille exportée. Seuls des
 * nombres d'un rapport déjà remis en forme par le main entrent ici.
 */
import type { ResponsiveIssueKind, ResponsiveReport } from "../types/device-matrix";

/** Au-delà, une capture n'est plus lisible sous ses cadres. */
export const MAX_MARKERS = 60;
/** Plus petit côté d'un repère, en part de la fenêtre : une boîte d'un pixel reste visible. */
const MIN_SIDE = 0.004;

export interface IssueMarker {
	readonly kind: ResponsiveIssueKind;
	readonly selector: string;
	/** Parts de la fenêtre, entre 0 et 1. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Les repères visibles sur une fenêtre de `width` × `height` pixels CSS. */
export function issueMarkers(report: ResponsiveReport | null, width: number, height: number): IssueMarker[] {
	if (!report || width <= 0 || height <= 0) return [];
	const markers: IssueMarker[] = [];
	for (const issue of report.issues) {
		for (const sample of issue.samples) {
			if (markers.length >= MAX_MARKERS) return markers;
			// Hors de la fenêtre (sous la ligne de flottaison, à côté de l'écran) : rien à encadrer sur l'image.
			const outside =
				sample.x >= width || sample.y >= height || sample.x + sample.width < 0 || sample.y + sample.height < 0;
			if (outside) continue;
			const left = clamp(sample.x / width);
			const top = clamp(sample.y / height);
			const right = clamp((sample.x + sample.width) / width);
			const bottom = clamp((sample.y + sample.height) / height);
			markers.push({
				kind: issue.kind,
				selector: sample.selector,
				x: Math.min(left, 1 - MIN_SIDE),
				y: Math.min(top, 1 - MIN_SIDE),
				width: Math.max(MIN_SIDE, right - left),
				height: Math.max(MIN_SIDE, bottom - top),
			});
		}
	}
	return markers;
}
