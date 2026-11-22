/**
 * Relire une page à plusieurs largeurs (#383) : les points de rupture qu'elle
 * déclare, puis les bugs responsive juste avant et juste après chacun.
 *
 * La page est chargée une fois sur l'appareil choisi (`withDevicePage` : même
 * fenêtre cachée, mêmes gardes que la capture). Un script en lecture seule,
 * dans le monde isolé, relève les conditions `@media` des feuilles de style
 * que la page peut lire (une feuille d'une autre origine ne se lit pas et
 * n'est pas comptée) ; le main en tire les seuils de largeur. Puis la fenêtre
 * émulée prend chaque largeur (une liste fixe de largeurs courantes, plus un
 * pixel de part et d'autre de chaque seuil), et la lecture de la page
 * (`RESPONSIVE_PROBE`) y repasse. Rien n'est photographié : on rend des
 * comptes par largeur.
 *
 * Ce que la page répond est une donnée : les conditions sont des chaînes
 * bornées, analysées par le main, et seuls des nombres dans les bornes d'une
 * fenêtre en sortent.
 */
import type { BreakpointScan, BreakpointStep } from "../../shared/types/device-library";
import type { DevicePreset } from "../../shared/types/device-matrix";
import { CUSTOM_DEVICE_LIMITS } from "../../shared/utils/custom-device";
import {
	type CaptureOptions,
	NO_THROTTLING,
	emulate,
	runProbe,
	sameOrigin,
	wait,
	withDevicePage,
	withTimeout,
} from "./device-capture";
import { buildProbe, sanitizeReport } from "./responsive-probe";

/** Les largeurs toujours relues : petit téléphone, téléphones, tablettes, portables, bureau. */
export const SCAN_WIDTHS: readonly number[] = [320, 375, 414, 768, 1024, 1280, 1440, 1920];
/** Seuils gardés au plus : avec deux largeurs chacun, 32 relectures au plus. */
export const MAX_BREAKPOINTS = 12;
/** Conditions lues au plus, et leur longueur. */
export const MAX_MEDIA_TEXTS = 400;
export const MAX_MEDIA_TEXT = 300;
/** Le temps laissé à la page pour se remettre en page à une nouvelle largeur. */
export const STEP_SETTLE_MS = 300;
/** Une lecture qui ne répond pas dans ce délai compte comme illisible. */
export const STEP_TIMEOUT_MS = 5_000;
/** `em` et `rem` d'une media query valent la taille de police initiale : 16 px. */
const EM_PX = 16;

/**
 * Le script de relevé : les `mediaText` des règles `@media` et `@import`, en
 * profondeur (`@supports`, `@layer`, `@media` imbriqués), sans rien écrire.
 */
export const MEDIA_PROBE = `(function (o) {
  var found = [];
  function add(text) {
    if (typeof text === "string" && text && found.length < o.max) found.push(text.slice(0, o.len));
  }
  function walk(rules, depth) {
    if (!rules || depth > 6) return;
    for (var i = 0; i < rules.length && found.length < o.max; i++) {
      var rule = rules[i];
      if (rule.media && typeof rule.media.mediaText === "string") add(rule.media.mediaText);
      var inner = null;
      try { inner = rule.cssRules || (rule.styleSheet && rule.styleSheet.cssRules) || null; } catch (e) { inner = null; }
      walk(inner, depth + 1);
    }
  }
  var sheets = document.styleSheets;
  for (var s = 0; s < sheets.length && found.length < o.max; s++) {
    var rules = null;
    try { rules = sheets[s].cssRules; } catch (e) { rules = null; }
    walk(rules, 0);
  }
  return found;
})`;

export function buildMediaProbe(): string {
	return `${MEDIA_PROBE}(${JSON.stringify({ max: MAX_MEDIA_TEXTS, len: MAX_MEDIA_TEXT })})`;
}

/** `min-width: 48em`, `max-width:1024px`, `width >= 768px` : le nombre suit le nom. */
const WIDTH_THEN_VALUE =
	/\b(?:(?:min|max)-width\s*:|width\s*(?:<=|>=|<|>))\s*(\d+(?:\.\d+)?)(px|r?em)\b/gi;
/** `600px < width` : le nombre précède le nom (syntaxe d'intervalle). */
const VALUE_THEN_WIDTH = /\b(\d+(?:\.\d+)?)(px|r?em)\s*(?:<=|>=|<|>)\s*width\b/gi;

/** Les seuils de largeur, en pixels CSS, que déclarent ces conditions : bornés, uniques, triés. */
export function parseBreakpoints(raw: unknown): number[] {
	if (!Array.isArray(raw)) return [];
	const found = new Set<number>();
	for (const text of raw.slice(0, MAX_MEDIA_TEXTS)) {
		if (typeof text !== "string") continue;
		const bounded = text.slice(0, MAX_MEDIA_TEXT);
		for (const match of [...bounded.matchAll(WIDTH_THEN_VALUE), ...bounded.matchAll(VALUE_THEN_WIDTH)]) {
			const value = Number(match[1]);
			const px = Math.round(match[2].toLowerCase() === "px" ? value : value * EM_PX);
			if (px >= CUSTOM_DEVICE_LIMITS.minSide && px <= CUSTOM_DEVICE_LIMITS.maxSide) found.add(px);
		}
	}
	return [...found].sort((a, b) => a - b).slice(0, MAX_BREAKPOINTS);
}

/**
 * Les largeurs à relire : les largeurs courantes, plus un pixel de part et
 * d'autre de chaque seuil (`min-width: 768px` s'applique à 769 et pas à 767,
 * `max-width: 768px` l'inverse).
 */
export function scanWidths(breakpoints: readonly number[]): number[] {
	const widths = new Set(SCAN_WIDTHS);
	for (const breakpoint of breakpoints.slice(0, MAX_BREAKPOINTS)) {
		for (const width of [breakpoint - 1, breakpoint + 1]) {
			if (width >= CUSTOM_DEVICE_LIMITS.minSide && width <= CUSTOM_DEVICE_LIMITS.maxSide) widths.add(width);
		}
	}
	return [...widths].sort((a, b) => a - b);
}

/** Une lecture réduite à ses comptes ; `null` quand la page n'a pas répondu. */
function step(width: number, raw: unknown): BreakpointStep | null {
	const report = sanitizeReport(raw);
	if (!report) return null;
	return {
		width,
		scrollWidth: report.scrollWidth,
		truncated: report.truncated,
		issues: report.issues.map(({ kind, count }) => ({ kind, count })),
	};
}

/** Relit `url` sur `device` à chaque largeur ; la hauteur, la densité et le navigateur restent ceux de l'appareil. */
export function scanBreakpoints(
	device: DevicePreset,
	url: string,
	options: CaptureOptions,
): Promise<Omit<BreakpointScan, "deviceId">> {
	return withDevicePage(device, url, NO_THROTTLING, options, async ({ wc, send, origin }) => {
		const breakpoints = parseBreakpoints(await runProbe(wc, buildMediaProbe()));
		const steps: BreakpointStep[] = [];
		for (const width of scanWidths(breakpoints)) {
			await emulate(send, { ...device, width });
			await wait(STEP_SETTLE_MS);
			const raw = await withTimeout(runProbe(wc, buildProbe(device)), STEP_TIMEOUT_MS).catch(() => null);
			const read = step(width, raw);
			if (read) steps.push(read);
		}
		const shown = wc.getURL();
		return { url: sameOrigin(shown, origin) ? shown : url, breakpoints, steps };
	});
}
