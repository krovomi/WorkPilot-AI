/**
 * La lecture d'une page rendue sur un appareil de la matrice (#383) : les
 * bugs responsive qu'un œil repère sur une capture, nommés et localisés.
 *
 * `RESPONSIVE_PROBE` tourne dans la page, dans un monde isolé (même DOM, pas
 * les globales de la page : elle ne peut pas remplacer `getComputedStyle`
 * sous nos pieds). Il ne fait que lire — aucune écriture dans le DOM, aucun
 * évènement — et il s'arrête à `MAX_ELEMENTS` éléments. Ce qu'il rend reste
 * une réponse de la page : `sanitizeReport` le remet en forme et le borne
 * avant qu'il quitte le main.
 *
 * Les seuils viennent des recommandations qu'on cite d'habitude : 44 × 44 px
 * pour une cible tactile (Apple HIG, WCAG 2.5.5), 12 px pour un texte lisible
 * sur mobile (Lighthouse « legible font sizes »).
 */
import type { DevicePreset, ResponsiveIssue, ResponsiveIssueKind, ResponsiveIssueSample, ResponsiveReport } from "../../shared/types/device-matrix";

export const MIN_TOUCH_TARGET_PX = 44;
export const MIN_TEXT_PX = 12;
export const MAX_SAMPLES = 10;
export const MAX_ELEMENTS = 4000;
const MAX_SELECTOR = 120;
const MAX_COORDINATE = 100_000;

export const ISSUE_KINDS: readonly ResponsiveIssueKind[] = [
	"horizontal-overflow",
	"overflowing-media",
	"small-touch-target",
	"small-text",
];

/**
 * Le script, sous forme d'expression de fonction : `buildProbe` l'appelle
 * avec des options écrites ici, jamais avec une valeur venue du renderer.
 *
 * Un élément qui dépasse la fenêtre n'est compté qu'une fois : ses
 * descendants ne sont plus examinés, ni ceux d'un conteneur qui coupe ou fait
 * défiler son contenu (un carrousel est un défilement voulu). Un lien en
 * ligne échappe à la règle des 44 px, comme le prévoit WCAG.
 */
export const RESPONSIVE_PROBE = `(function (o) {
	var root = document.documentElement;
	var vw = window.innerWidth || root.clientWidth;
	var kinds = ["horizontal-overflow", "overflowing-media", "small-touch-target", "small-text"];
	var counts = {};
	var samples = {};
	kinds.forEach(function (k) { counts[k] = 0; samples[k] = []; });
	var describe = function (el) {
		var cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".") : "";
		return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "");
	};
	var add = function (kind, el, r) {
		counts[kind] += 1;
		if (samples[kind].length < o.maxSamples) {
			samples[kind].push({ selector: describe(el), x: r.left, y: r.top + window.scrollY, width: r.width, height: r.height });
		}
	};
	var media = /^(IMG|VIDEO|CANVAS|SVG|IFRAME|PICTURE|OBJECT|EMBED)$/;
	var interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
	var roles = /^(button|link|checkbox|radio|switch|tab|menuitem|option)$/;
	var all = document.body ? document.body.getElementsByTagName("*") : [];
	var limit = Math.min(all.length, o.maxElements);
	var settled = new Set();
	for (var i = 0; i < limit; i += 1) {
		var el = all[i];
		if (el.parentElement && settled.has(el.parentElement)) { settled.add(el); continue; }
		var cs = getComputedStyle(el);
		var r = el.getBoundingClientRect();
		if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0 || r.height === 0) continue;
		var tag = el.tagName.toUpperCase();
		if (r.right > vw + 1 || r.left < -1) {
			add(media.test(tag) ? "overflowing-media" : "horizontal-overflow", el, r);
			settled.add(el);
			continue;
		}
		if (cs.overflowX !== "visible") settled.add(el);
		if (o.touch && cs.display !== "inline") {
			var role = el.getAttribute("role") || "";
			var target = (interactive.test(tag) && !(tag === "A" && !el.hasAttribute("href"))) || roles.test(role);
			if (target && (r.width < o.minTouch || r.height < o.minTouch)) add("small-touch-target", el, r);
		}
		if (o.text && parseFloat(cs.fontSize) < o.minText) {
			for (var c = el.firstChild; c; c = c.nextSibling) {
				if (c.nodeType === 3 && c.textContent.trim()) { add("small-text", el, r); break; }
			}
		}
	}
	return {
		viewportWidth: vw,
		scrollWidth: root.scrollWidth,
		scanned: limit,
		truncated: all.length > limit,
		issues: kinds.map(function (k) { return { kind: k, count: counts[k], samples: samples[k] }; }),
	};
})`;

/** L'appel du script pour un appareil : le texte n'est vérifié que sur mobile, les cibles que sur un écran tactile. */
export function buildProbe(device: Pick<DevicePreset, "mobile" | "touch">): string {
	const options = {
		touch: device.touch,
		text: device.mobile,
		minTouch: MIN_TOUCH_TARGET_PX,
		minText: MIN_TEXT_PX,
		maxSamples: MAX_SAMPLES,
		maxElements: MAX_ELEMENTS,
	};
	return `${RESPONSIVE_PROBE}(${JSON.stringify(options)})`;
}

function readNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.round(Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, value)));
}

function readCount(value: unknown): number {
	return Math.max(0, readNumber(value));
}

function readSelector(value: unknown): string {
	if (typeof value !== "string") return "";
	// Les caractères de contrôle partent : un sélecteur s'affiche sur une ligne.
	return Array.from(value.slice(0, MAX_SELECTOR * 2))
		.filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
		.join("")
		.slice(0, MAX_SELECTOR);
}

function readSample(value: unknown): ResponsiveIssueSample | null {
	if (!value || typeof value !== "object") return null;
	const sample = value as Record<string, unknown>;
	const selector = readSelector(sample.selector);
	if (!selector) return null;
	return {
		selector,
		x: readNumber(sample.x),
		y: readNumber(sample.y),
		width: readCount(sample.width),
		height: readCount(sample.height),
	};
}

/**
 * Le rapport tel que le main le transmet : seules les sortes connues, une fois
 * chacune, des nombres finis et bornés, au plus `MAX_SAMPLES` exemples par
 * sorte. `null` quand la page n'a rien rendu d'exploitable.
 */
export function sanitizeReport(raw: unknown): ResponsiveReport | null {
	if (!raw || typeof raw !== "object") return null;
	const report = raw as Record<string, unknown>;
	const received = Array.isArray(report.issues) ? report.issues : [];
	const issues: ResponsiveIssue[] = [];
	for (const kind of ISSUE_KINDS) {
		const entry = received.find(
			(item): item is Record<string, unknown> =>
				Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).kind === kind,
		);
		if (!entry) continue;
		const samples = (Array.isArray(entry.samples) ? entry.samples : [])
			.slice(0, MAX_SAMPLES)
			.map(readSample)
			.filter((sample): sample is ResponsiveIssueSample => sample !== null);
		const count = Math.max(readCount(entry.count), samples.length);
		if (count > 0) issues.push({ kind, count, samples });
	}
	return {
		viewportWidth: readCount(report.viewportWidth),
		scrollWidth: readCount(report.scrollWidth),
		scanned: readCount(report.scanned),
		truncated: report.truncated === true,
		issues,
	};
}
