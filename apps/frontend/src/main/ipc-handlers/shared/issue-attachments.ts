/**
 * Images d'une issue GitHub ou GitLab, téléchargées dans `attachments/`.
 *
 * Une capture d'erreur collée dans une issue n'atteignait aucun agent :
 * l'import ne copiait que le texte, où l'image n'est qu'une URL. Écrite dans
 * `<specDir>/attachments/`, elle passe par le même chemin qu'une image déposée
 * sur une carte, ou qu'une pièce jointe Jira ou Azure DevOps : `docintel` la
 * lit avant la planification (OCR local, secrets masqués, `injection_guard`).
 *
 * Trois règles, les mêmes que pour Jira :
 * - **le jeton ne part que vers l'hôte de l'instance** — une image hébergée
 *   ailleurs est ignorée plutôt que demandée avec lui. Une redirection (GitHub
 *   renvoie vers un stockage signé) est suivie une fois, **sans** jeton ;
 * - **au plus 10 images de 5 Mo**, vérifiées sur les octets reçus et non sur
 *   ce que l'hôte annonce ;
 * - **ne lève jamais** : une image qui ne se télécharge pas est une image de
 *   moins, pas un import raté.
 *
 * Tout se passe dans le processus principal ; le renderer ne voit ni le jeton,
 * ni les octets.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_ISSUE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ISSUE_IMAGES = 10;

/** Le type d'après les premiers octets : l'extension d'une URL ne prouve rien. */
export function sniffImage(data: Buffer): { mimeType: string; extension: string } | null {
	if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { mimeType: "image/png", extension: "png" };
	}
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
		return { mimeType: "image/jpeg", extension: "jpg" };
	}
	const head = data.subarray(0, 12).toString("latin1");
	if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
		return { mimeType: "image/gif", extension: "gif" };
	}
	if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
		return { mimeType: "image/webp", extension: "webp" };
	}
	if (head.startsWith("BM")) return { mimeType: "image/bmp", extension: "bmp" };
	return null;
}

/**
 * Les URL d'images d'un corps Markdown (`![alt](url)`, `<img src>`), résolues
 * contre `base` quand elles sont relatives (les `/uploads/…` de GitLab), dans
 * l'ordre, chacune une fois.
 */
export function issueImageUrls(markdown: string, base: string): string[] {
	if (!markdown) return [];
	const found: string[] = [];
	const seen = new Set<string>();
	const patterns = [
		/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g,
		/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi,
	];
	for (const pattern of patterns) {
		for (const match of markdown.matchAll(pattern)) {
			let url: URL;
			try {
				url = new URL(match[1], base);
			} catch {
				continue;
			}
			if (url.protocol !== "https:" && url.protocol !== "http:") continue;
			const key = url.toString();
			if (!seen.has(key)) {
				seen.add(key);
				found.push(key);
			}
		}
	}
	return found;
}

export function sameHost(url: string, host: string): boolean {
	try {
		return new URL(url).host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}

export interface DownloadedImage {
	filename: string;
	mimeType: string;
	data: Buffer;
}

export interface IssueImageSource {
	/** L'hôte qui reçoit le jeton : `github.com`, `gitlab.example.com`. */
	host: string;
	/** En-têtes d'authentification, envoyés à `host` seulement. */
	headers: Record<string, string>;
	/** Réécrit une URL de l'hôte en celle à demander (l'API d'uploads de GitLab). */
	rewrite?: (url: URL) => string;
}

async function readBody(response: Response): Promise<Buffer | null> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > MAX_ISSUE_IMAGE_BYTES) return null;
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length === 0 || buffer.length > MAX_ISSUE_IMAGE_BYTES) return null;
	return buffer;
}

async function fetchOne(
	url: string,
	source: IssueImageSource,
	fetchImpl: typeof fetch,
): Promise<Buffer | null> {
	const response = await fetchImpl(url, {
		headers: source.headers,
		redirect: "manual",
	});
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get("location");
		if (!location) return null;
		const next = new URL(location, url);
		if (next.protocol !== "https:") return null;
		// Une seule redirection, sans jeton : le stockage signé vers lequel
		// GitHub renvoie n'en a pas besoin, et ce n'est plus l'instance.
		const followed = await fetchImpl(next.toString(), { redirect: "error" });
		return followed.ok ? readBody(followed) : null;
	}
	return response.ok ? readBody(response) : null;
}

function rewriteUrl(url: string, source: IssueImageSource): string | null {
	try {
		return source.rewrite ? source.rewrite(new URL(url)) : url;
	} catch {
		return null;
	}
}

/** Télécharge les images d'un corps d'issue hébergées sur l'instance. */
export async function downloadIssueImages(
	markdown: string,
	base: string,
	source: IssueImageSource,
	prefix: string,
	fetchImpl: typeof fetch = fetch,
): Promise<DownloadedImage[]> {
	const images: DownloadedImage[] = [];
	const seen = new Set<string>();
	for (const url of issueImageUrls(markdown, base)) {
		if (images.length >= MAX_ISSUE_IMAGES) break;
		if (!sameHost(url, source.host)) continue;
		const target = rewriteUrl(url, source);
		if (target === null || !sameHost(target, source.host)) continue;
		try {
			const data = await fetchOne(target, source, fetchImpl);
			if (!data) continue;
			const kind = sniffImage(data);
			if (!kind) continue;
			const digest = data.toString("base64", 0, 64);
			if (seen.has(digest)) continue;
			seen.add(digest);
			images.push({
				filename: `${prefix}-image-${images.length + 1}.${kind.extension}`,
				mimeType: kind.mimeType,
				data,
			});
		} catch {
			// Une image de moins.
		}
	}
	return images;
}

/** Écrit les images dans `<specDir>/attachments/`. Renvoie les noms écrits. */
export function saveIssueImages(
	images: DownloadedImage[],
	specDir: string,
): string[] {
	if (images.length === 0) return [];
	const directory = path.join(specDir, "attachments");
	const written: string[] = [];
	try {
		mkdirSync(directory, { recursive: true });
	} catch {
		return written;
	}
	for (const image of images) {
		const name = image.filename.replace(/[^A-Za-z0-9._-]/g, "_");
		try {
			writeFileSync(path.join(directory, name), image.data);
			written.push(name);
		} catch {
			// Une capture de moins, pas un import raté.
		}
	}
	return written;
}

/**
 * GitHub : les images collées dans une issue vivent sur `github.com`
 * (`/user-attachments/assets/…`, `/<owner>/<repo>/assets/…`) et exigent le
 * jeton pour un dépôt privé. Les anciennes URL `*.githubusercontent.com` sont
 * un autre hôte : ignorées, comme le veut la règle du même hôte.
 */
export async function attachGitHubIssueImages(
	token: string,
	body: string | undefined,
	issueNumber: number,
	specDir: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
	try {
		const images = await downloadIssueImages(
			body ?? "",
			"https://github.com/",
			{
				host: "github.com",
				headers: {
					Authorization: `Bearer ${token}`,
					"User-Agent": "WorkPilot-AI",
				},
			},
			`github-${issueNumber}`,
			fetchImpl,
		);
		return saveIssueImages(images, specDir);
	} catch {
		return [];
	}
}

const GITLAB_UPLOAD = /\/uploads\/([0-9a-f]{16,64})\/([^/?#]+)$/i;

/**
 * GitLab : une image collée est un `/uploads/<secret>/<fichier>` relatif au
 * projet. Depuis GitLab 17, le chemin web exige une session : il est demandé
 * par l'API (`/api/v4/projects/:id/uploads/:secret/:fichier`), qui accepte
 * `PRIVATE-TOKEN`, sur l'hôte de l'instance seulement.
 */
export async function attachGitLabIssueImages(
	token: string,
	instanceUrl: string,
	project: string,
	description: string | undefined,
	issueIid: number,
	specDir: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
	try {
		const instance = new URL(instanceUrl);
		const base = `${instance.origin}/${project.replace(/^\/+|\/+$/g, "")}/`;
		const encoded = /^\d+$/.test(project) ? project : encodeURIComponent(project);
		const images = await downloadIssueImages(
			description ?? "",
			base,
			{
				host: instance.host,
				headers: { "PRIVATE-TOKEN": token },
				rewrite: (url) => {
					const match = GITLAB_UPLOAD.exec(url.pathname);
					if (!match) return url.toString();
					return `${instance.origin}/api/v4/projects/${encoded}/uploads/${match[1]}/${match[2]}`;
				},
			},
			`gitlab-${issueIid}`,
			fetchImpl,
		);
		return saveIssueImages(images, specDir);
	} catch {
		return [];
	}
}
