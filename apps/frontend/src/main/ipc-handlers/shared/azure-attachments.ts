/**
 * Téléchargement et inlining des pièces jointes images Azure DevOps.
 *
 * Les descriptions de work items (US, RsD/bugs) référencent les captures via
 * `https://dev.azure.com/<org>/.../_apis/wit/attachments/<guid>?fileName=...`.
 * Ces URLs nécessitent une authentification PAT : chargées telles quelles dans
 * le renderer Electron (sans en-tête d'auth), elles renvoient un timeout
 * (`ERR_TIMED_OUT`) et les images apparaissent cassées.
 *
 * En les téléchargeant côté main (avec le PAT, comme le fait l'API Python) puis
 * en les inlinant en data URIs base64 dans le HTML, elles s'affichent sans
 * authentification ni accès réseau au moment du rendu.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Taille maximale d'une pièce jointe image inlinée en data URI (5 Mo). */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Indique si une URL pointe vers une pièce jointe Azure DevOps protégée par PAT.
 */
export function isAzureDevOpsAttachmentUrl(src: string, orgUrl?: string): boolean {
	let host = "";
	try {
		host = new URL(src).host.toLowerCase();
	} catch {
		return false;
	}

	let orgHost = "";
	if (orgUrl) {
		try {
			orgHost = new URL(orgUrl).host.toLowerCase();
		} catch {
			orgHost = "";
		}
	}

	const isAzureHost =
		host === "dev.azure.com" ||
		host.endsWith(".dev.azure.com") ||
		host.endsWith(".visualstudio.com") ||
		(orgHost !== "" && host === orgHost);

	return isAzureHost && src.includes("/_apis/wit/attachments/");
}

/**
 * Remplace dans `html` les `<img>` pointant vers des pièces jointes Azure DevOps
 * par des data URIs base64 téléchargés avec le PAT.
 *
 * En cas d'échec (réseau, taille, type), l'URL d'origine est conservée afin de
 * ne jamais bloquer l'import.
 */
export async function inlineAzureDevOpsImages(
	html: string,
	orgUrl: string,
	pat: string,
): Promise<string> {
	if (!html?.includes("<img") || !pat) return html;

	const authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

	const imgRegex = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
	const sources = new Set<string>();
	for (const match of html.matchAll(imgRegex)) {
		const src = match[2];
		if (src) sources.add(src);
	}

	let result = html;
	for (const src of sources) {
		if (src.startsWith("data:")) continue;
		if (!isAzureDevOpsAttachmentUrl(src, orgUrl)) continue;

		try {
			const response = await fetch(src, {
				headers: { Authorization: authHeader },
			});
			if (!response.ok) continue;

			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.length === 0 || buffer.length > MAX_INLINE_IMAGE_BYTES) {
				continue;
			}

			const contentType =
				response.headers.get("content-type")?.split(";")[0]?.trim() ||
				"image/png";
			if (!contentType.startsWith("image/")) continue;

			const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;
			result = result.split(src).join(dataUri);
		} catch {
			// Conserver l'URL d'origine sans bloquer l'import.
		}
	}

	return result;
}

/**
 * Retire les balises `<img>` qui pointent encore vers une pièce jointe Azure
 * DevOps protégée par PAT (c.-à-d. non inlinées en data URI).
 *
 * Utilisé en repli quand l'inlining est impossible (pas de PAT) ou a échoué :
 * sans cela, le renderer émet une requête réseau vers `dev.azure.com` sans
 * authentification qui finit en `ERR_TIMED_OUT` et affiche une image cassée.
 */
export function stripAzureAttachmentImages(
	html: string,
	orgUrl?: string,
): string {
	if (!html?.includes("<img")) return html;
	return html.replace(
		/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi,
		(full, _quote, src) =>
			isAzureDevOpsAttachmentUrl(src, orgUrl) ? "" : full,
	);
}

/** Types d'image acceptés en pièce jointe, et leur extension sur le disque. */
const ATTACHMENT_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

export interface InlinedImage {
	mimeType: string;
	extension: string;
	data: Buffer;
}

/**
 * Les images qu'`inlineAzureDevOpsImages` a inlinées en data URIs, décodées.
 *
 * Seules les data URIs d'un type image connu sont retenues (un SVG est du
 * code, pas une capture), et chaque contenu n'apparaît qu'une fois même s'il
 * est cité plusieurs fois dans la description.
 */
export function extractInlinedImages(html: string): InlinedImage[] {
	if (!html?.includes("data:image/")) return [];
	const images: InlinedImage[] = [];
	const seen = new Set<string>();
	const dataUri = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;
	for (const match of html.matchAll(dataUri)) {
		const mimeType = match[1].toLowerCase();
		const extension = ATTACHMENT_EXTENSIONS[mimeType];
		if (!extension || seen.has(match[2])) continue;
		seen.add(match[2]);
		const data = Buffer.from(match[2], "base64");
		if (data.length === 0 || data.length > MAX_INLINE_IMAGE_BYTES) continue;
		images.push({ mimeType, extension, data });
	}
	return images;
}

/**
 * Écrit les captures d'un work item dans `<specDir>/attachments/`.
 *
 * L'inlining ne servait qu'à l'affichage : les agents lisent les pièces
 * jointes de la tâche (`docintel`, avant la planification), jamais le HTML de
 * la description. Une capture d'erreur ou une maquette jointe au ticket
 * n'atteignait donc aucun agent. Écrite ici, elle passe par le même chemin
 * qu'une image déposée à la main dans le Kanban.
 *
 * Ne lève jamais : une capture qui ne s'écrit pas ne bloque pas l'import.
 * Renvoie les noms de fichiers écrits.
 */
export function saveInlinedImagesAsAttachments(
	html: string,
	specDir: string,
	prefix: string,
): string[] {
	const images = extractInlinedImages(html);
	if (images.length === 0) return [];
	const directory = path.join(specDir, "attachments");
	const written: string[] = [];
	try {
		mkdirSync(directory, { recursive: true });
	} catch {
		return written;
	}
	images.forEach((image, index) => {
		const filename = `${prefix}-image-${index + 1}.${image.extension}`;
		try {
			writeFileSync(path.join(directory, filename), image.data);
			written.push(filename);
		} catch {
			// Une capture de moins, pas un import raté.
		}
	});
	return written;
}
