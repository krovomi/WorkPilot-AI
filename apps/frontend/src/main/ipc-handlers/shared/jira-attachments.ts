/**
 * Pièces jointes images d'une issue Jira, téléchargées pour la tâche importée.
 *
 * Une capture d'erreur ou une maquette jointe au ticket n'atteignait aucun
 * agent : l'import ne copiait que le titre, la description et les critères.
 * Les images sont renvoyées au format `ImageAttachment` (base64), ce qui les
 * fait passer par le même chemin qu'une image déposée à la main sur une
 * carte : `TASK_CREATE` les écrit dans `attachments/`, et `docintel` les lit
 * avant la planification. Un export PNG ou SVG de draw.io y est lu comme un
 * schéma, puisqu'il embarque sa source.
 *
 * Les identifiants ne partent que vers l'instance configurée : une URL de
 * contenu qui pointe ailleurs est ignorée plutôt que suivie avec le jeton.
 */

import { randomUUID } from "node:crypto";
import type { ImageAttachment } from "../../../shared/types";

/** Même plafond que les pièces jointes Azure DevOps inlinées. */
export const MAX_JIRA_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_JIRA_IMAGES = 10;

/** Les types que `TASK_CREATE` accepte d'écrire. */
const ALLOWED_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
]);

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

export interface JiraAttachmentMeta {
	filename: string;
	mimeType: string;
	size: number;
	content: string;
}

function sameHost(url: string, instanceUrl: string): boolean {
	try {
		return new URL(url).host === new URL(instanceUrl).host;
	} catch {
		return false;
	}
}

/**
 * Les pièces jointes d'une réponse `fields=attachment` qui méritent d'être
 * téléchargées : images d'un type accepté, sous le plafond, sur l'instance.
 */
export function selectImageAttachments(
	payload: unknown,
	instanceUrl: string,
): JiraAttachmentMeta[] {
	const fields = (payload as { fields?: { attachment?: unknown } })?.fields;
	const raw = Array.isArray(fields?.attachment) ? fields.attachment : [];
	const selected: JiraAttachmentMeta[] = [];
	for (const entry of raw as Record<string, unknown>[]) {
		const mimeType = String(entry?.mimeType ?? "").toLowerCase();
		const size = Number(entry?.size ?? 0);
		const content = String(entry?.content ?? "");
		const filename = String(entry?.filename ?? "");
		if (!ALLOWED_MIME_TYPES.has(mimeType)) continue;
		if (!filename || size <= 0 || size > MAX_JIRA_IMAGE_BYTES) continue;
		if (!sameHost(content, instanceUrl)) continue;
		selected.push({ filename, mimeType, size, content });
		if (selected.length >= MAX_JIRA_IMAGES) break;
	}
	return selected;
}

export interface JiraCredentials {
	instanceUrl: string;
	email: string;
	apiToken: string;
}

/**
 * Télécharge les images d'une issue. Ne lève jamais : une image qui ne se
 * télécharge pas est une image de moins, pas un import raté.
 */
export async function downloadJiraImageAttachments(
	credentials: JiraCredentials,
	issueKey: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ImageAttachment[]> {
	if (!ISSUE_KEY.test(issueKey)) return [];
	const base = credentials.instanceUrl.replace(/\/+$/, "");
	const headers = {
		Authorization: `Basic ${Buffer.from(
			`${credentials.email}:${credentials.apiToken}`,
		).toString("base64")}`,
		Accept: "application/json",
	};

	let metas: JiraAttachmentMeta[];
	try {
		// v2 répond sur Cloud comme sur Server/Data Center.
		const response = await fetchImpl(
			`${base}/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
			{ headers },
		);
		if (!response.ok) return [];
		metas = selectImageAttachments(await response.json(), base);
	} catch {
		return [];
	}

	const images: ImageAttachment[] = [];
	const used = new Set<string>();
	for (const meta of metas) {
		try {
			const response = await fetchImpl(meta.content, { headers });
			if (!response.ok) continue;
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.length === 0 || buffer.length > MAX_JIRA_IMAGE_BYTES) continue;
			images.push({
				id: randomUUID(),
				filename: uniqueName(`${issueKey}-${meta.filename}`, used),
				mimeType: meta.mimeType === "image/jpg" ? "image/jpeg" : meta.mimeType,
				size: buffer.length,
				data: buffer.toString("base64"),
			});
		} catch {
			// Une image de moins.
		}
	}
	return images;
}

/** Deux pièces jointes du même nom ne s'écrasent pas dans `attachments/`. */
function uniqueName(filename: string, used: Set<string>): string {
	const safe = filename.replace(/[\\/]/g, "_");
	let candidate = safe;
	let index = 2;
	while (used.has(candidate.toLowerCase())) {
		const dot = safe.lastIndexOf(".");
		candidate =
			dot > 0
				? `${safe.slice(0, dot)}-${index}${safe.slice(dot)}`
				: `${safe}-${index}`;
		index += 1;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}
