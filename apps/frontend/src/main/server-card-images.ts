/**
 * Images for a server card (server mode): the New Task dialog's attachments
 * and the review panel's screenshots.
 *
 * On a local card main writes them into the spec folder; a server card's
 * folder is on the server, so they travel in the request
 * (`apps/backend/shared_board/attachments.py`), which checks their bytes
 * again and stores them where the agents read them. An image that cannot go
 * is refused here, never dropped: the person would believe it was sent.
 */

/** What the server accepts (no SVG: it can carry script). */
const SERVER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
export const MAX_SERVER_IMAGES = 10;
export const MAX_SERVER_IMAGE_BYTES = 5_000_000;

export interface ServerImageUpload {
	filename: string;
	mimeType: string;
	data: string;
}

export type ImageUploads = { uploads: ServerImageUpload[]; error?: undefined } | { uploads?: undefined; error: string };

/** The images in the server's shape, or why they cannot be sent. */
export function serverImageUploads(images: unknown): ImageUploads {
	if (!Array.isArray(images) || images.length === 0) return { uploads: [] };
	if (images.length > MAX_SERVER_IMAGES) {
		return { error: `At most ${MAX_SERVER_IMAGES} images can be sent to a server card` };
	}
	const uploads: ServerImageUpload[] = [];
	for (const raw of images) {
		const image = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const filename = typeof image.filename === "string" ? image.filename : "";
		const mimeType = typeof image.mimeType === "string" ? image.mimeType : "";
		const data = typeof image.data === "string" ? image.data.replace(/^data:[^,]*,/, "") : "";
		if (!filename || !data) return { error: `The image ${filename || "?"} has no content to send` };
		if (!SERVER_IMAGE_TYPES.has(mimeType)) {
			return { error: `Only PNG, JPEG, GIF and WebP images can be sent to a server card (${filename})` };
		}
		if (Math.floor((data.length * 3) / 4) > MAX_SERVER_IMAGE_BYTES + 2) {
			return { error: `The image ${filename} is larger than 5 MB` };
		}
		uploads.push({ filename, mimeType, data });
	}
	return { uploads };
}
