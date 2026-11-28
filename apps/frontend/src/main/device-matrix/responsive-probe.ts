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
 *
 * Deux lectures s'ajoutent sur tous les appareils : le texte coupé ou qui
 * déborde de sa boîte (points de suspension, `overflow: hidden`, hauteur fixe
 * trop petite : `scrollWidth > clientWidth` ou `scrollHeight > clientHeight`
 * sans défilement possible), et les éléments qui se chevauchent (deux
 * contenus du flux normal dont les boîtes se recouvrent nettement).
 *
 * Sur mobile seulement, la navigation cassée : un bloc de navigation dont
 * aucun lien n'est visible sans qu'aucun bouton de menu ne permette de
 * l'ouvrir, ou un bouton de menu qui commande (`aria-controls`) un élément
 * absent de la page.
 */
import type { DevicePreset, ResponsiveIssue, ResponsiveIssueKind, ResponsiveIssueSample, ResponsiveReport } from "../../shared/types/device-matrix";

export const MIN_TOUCH_TARGET_PX = 44;
export const MIN_TEXT_PX = 12;
export const MAX_SAMPLES = 10;
export const MAX_ELEMENTS = 4000;
/** Éléments comparés deux à deux pour les chevauchements : 500 font 125 000 paires. */
export const MAX_OVERLAP_CANDIDATES = 500;
/** Part de la plus petite des deux boîtes recouverte pour parler de chevauchement. */
export const MIN_OVERLAP_RATIO = 0.25;
/** Blocs de navigation lus, liens lus par bloc, boutons de menu examinés. */
export const MAX_NAVIGATIONS = 20;
export const MAX_NAV_LINKS = 200;
export const MAX_MENU_TOGGLES = 500;
const MAX_SELECTOR = 120;
const MAX_COORDINATE = 100_000;

export const ISSUE_KINDS: readonly ResponsiveIssueKind[] = [
	"horizontal-overflow",
	"overflowing-media",
	"small-touch-target",
	"small-text",
	"overlapping-elements",
	"truncated-text",
	"broken-navigation",
];

/**
 * Le script, sous forme d'expression de fonction : `buildProbe` l'appelle
 * avec des options écrites ici, jamais avec une valeur venue du renderer.
 *
 * Un élément qui dépasse la fenêtre n'est compté qu'une fois : ses
 * descendants ne sont plus examinés, ni ceux d'un conteneur qui coupe ou fait
 * défiler son contenu (un carrousel est un défilement voulu). Un lien en
 * ligne échappe à la règle des 44 px, comme le prévoit WCAG.
 *
 * Un chevauchement ne compte que deux éléments qui portent un contenu
 * (texte, média, cible interactive), hors de toute position `fixed`,
 * `sticky` ou `absolute` (un en-tête collant, un badge sur une icône sont
 * voulus), dont aucun ne contient l'autre, et qui se recouvrent sur plus de
 * 2 px dans chaque sens et sur au moins `minOverlap` de la plus petite boîte.
 * L'exemple est leur intersection, nommée `a / b`.
 *
 * Un bouton de menu est un élément visible qui annonce ce qu'il ouvre :
 * `aria-expanded` ou `aria-controls`, un `summary`, ou l'étiquette d'une case
 * à cocher (le menu « hamburger » en CSS seul). Un lien est visible quand sa
 * boîte a une taille et touche la largeur de la fenêtre (un menu poussé hors
 * de l'écran par `transform` ne l'est pas).
 */
export const RESPONSIVE_PROBE = `(function (o) {
	var root = document.documentElement;
	var vw = window.innerWidth || root.clientWidth;
	var kinds = ["horizontal-overflow", "overflowing-media", "small-touch-target", "small-text", "overlapping-elements", "truncated-text", "broken-navigation"];
	var counts = {};
	var samples = {};
	kinds.forEach(function (k) { counts[k] = 0; samples[k] = []; });
	var describe = function (el) {
		var cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".") : "";
		return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "");
	};
	var push = function (kind, selector, x, y, width, height) {
		counts[kind] += 1;
		if (samples[kind].length < o.maxSamples) {
			samples[kind].push({ selector: selector, x: x, y: y + window.scrollY, width: width, height: height });
		}
	};
	var add = function (kind, el, r) { push(kind, describe(el), r.left, r.top, r.width, r.height); };
	var hasText = function (el) {
		for (var c = el.firstChild; c; c = c.nextSibling) {
			if (c.nodeType === 3 && c.textContent.trim()) return true;
		}
		return false;
	};
	var scrolls = /^(auto|scroll)$/;
	var placed = /^(fixed|sticky|absolute)$/;
	var media = /^(IMG|VIDEO|CANVAS|SVG|IFRAME|PICTURE|OBJECT|EMBED)$/;
	var interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
	var roles = /^(button|link|checkbox|radio|switch|tab|menuitem|option)$/;
	var all = document.body ? document.body.getElementsByTagName("*") : [];
	var limit = Math.min(all.length, o.maxElements);
	var settled = new Set();
	var floating = new Set();
	var candidates = [];
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
		var text = hasText(el);
		var role = el.getAttribute("role") || "";
		var target = (interactive.test(tag) && !(tag === "A" && !el.hasAttribute("href"))) || roles.test(role);
		if (o.touch && cs.display !== "inline") {
			if (target && (r.width < o.minTouch || r.height < o.minTouch)) add("small-touch-target", el, r);
		}
		if (o.text && text && parseFloat(cs.fontSize) < o.minText) add("small-text", el, r);
		if (text && cs.display !== "inline") {
			var cutX = !scrolls.test(cs.overflowX) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1;
			var cutY = !scrolls.test(cs.overflowY) && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1;
			if (cutX || cutY) add("truncated-text", el, r);
		}
		if (placed.test(cs.position) || (el.parentElement && floating.has(el.parentElement))) floating.add(el);
		else if ((text || target || media.test(tag)) && cs.opacity !== "0" && candidates.length < o.maxCandidates) {
			candidates.push({ el: el, r: r });
		}
	}
	for (var a = 0; a < candidates.length; a += 1) {
		for (var b = a + 1; b < candidates.length; b += 1) {
			var p = candidates[a];
			var q = candidates[b];
			if (p.el.contains(q.el) || q.el.contains(p.el)) continue;
			var left = Math.max(p.r.left, q.r.left);
			var top = Math.max(p.r.top, q.r.top);
			var w = Math.min(p.r.right, q.r.right) - left;
			var h = Math.min(p.r.bottom, q.r.bottom) - top;
			if (w <= 2 || h <= 2) continue;
			var smaller = Math.min(p.r.width * p.r.height, q.r.width * q.r.height);
			if (w * h < smaller * o.minOverlap) continue;
			push("overlapping-elements", describe(p.el) + " / " + describe(q.el), left, top, w, h);
		}
	}
	var shown = function (el) {
		var s = getComputedStyle(el);
		var box = el.getBoundingClientRect();
		return s.display !== "none" && s.visibility !== "hidden" && box.width > 0 && box.height > 0 && box.right > 0 && box.left < vw;
	};
	if (o.nav) {
		var toggles = Array.prototype.slice.call(
			document.querySelectorAll("[aria-expanded], [aria-controls], summary, label[for]"), 0, o.maxToggles
		).filter(function (t) {
			if (t.tagName === "LABEL") {
				var box = document.getElementById(t.getAttribute("for") || "");
				if (!box || box.getAttribute("type") !== "checkbox") return false;
			}
			return shown(t);
		});
		var navs = Array.prototype.slice.call(document.querySelectorAll("nav, [role=navigation]"), 0, o.maxNavs);
		navs.forEach(function (nav) {
			var links = Array.prototype.slice.call(nav.querySelectorAll("a[href]"), 0, o.maxLinks);
			if (links.length === 0 || links.some(shown) || toggles.length > 0) return;
			add("broken-navigation", nav, nav.getBoundingClientRect());
		});
		toggles.forEach(function (t) {
			var ids = (t.getAttribute("aria-controls") || "").split(/\\s+/).filter(Boolean);
			if (ids.length === 0 || ids.some(function (id) { return document.getElementById(id); })) return;
			add("broken-navigation", t, t.getBoundingClientRect());
		});
	}
	return {
		viewportWidth: vw,
		scrollWidth: root.scrollWidth,
		scanned: limit,
		truncated: all.length > limit,
		issues: kinds.map(function (k) { return { kind: k, count: counts[k], samples: samples[k] }; }),
	};
})`;

/** L'appel du script pour un appareil : le texte et la navigation ne sont vérifiés que sur mobile, les cibles que sur un écran tactile. */
export function buildProbe(device: Pick<DevicePreset, "mobile" | "touch">): string {
	const options = {
		touch: device.touch,
		text: device.mobile,
		nav: device.mobile,
		minTouch: MIN_TOUCH_TARGET_PX,
		minText: MIN_TEXT_PX,
		maxSamples: MAX_SAMPLES,
		maxElements: MAX_ELEMENTS,
		maxCandidates: MAX_OVERLAP_CANDIDATES,
		minOverlap: MIN_OVERLAP_RATIO,
		maxNavs: MAX_NAVIGATIONS,
		maxLinks: MAX_NAV_LINKS,
		maxToggles: MAX_MENU_TOGGLES,
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
