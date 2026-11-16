/**
 * Helpers for the images attached to a task, a QA review or a changelog:
 * ids, accepted types, data URLs, thumbnails and unique file names.
 */
import { ALLOWED_IMAGE_TYPES } from "../../shared/constants";

/** A unique id for an attached image. */
export function generateImageId(): string {
	return `img-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Whether a MIME type is one of the accepted image types. */
export function isValidImageMimeType(mimeType: string): boolean {
	return ALLOWED_IMAGE_TYPES.includes(
		mimeType as (typeof ALLOWED_IMAGE_TYPES)[number],
	);
}

/** A Blob (or File) as a base64 data URL. */
export async function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

/**
 * A JPEG thumbnail of an image data URL, at most `maxSize` pixels on its
 * longer side; the original data URL when the image cannot be decoded.
 */
export async function createThumbnail(
	dataUrl: string,
	maxSize = 200,
): Promise<string> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement("canvas");
			let width = img.width;
			let height = img.height;

			// Scale down to maxSize while maintaining aspect ratio
			if (width > height) {
				if (width > maxSize) {
					height = (height * maxSize) / width;
					width = maxSize;
				}
			} else if (height > maxSize) {
				width = (width * maxSize) / height;
				height = maxSize;
			}

			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			ctx?.drawImage(img, 0, 0, width, height);
			resolve(canvas.toDataURL("image/jpeg", 0.8));
		};
		img.onerror = () => resolve(dataUrl);
		img.src = dataUrl;
	});
}

/** `filename`, with a timestamp before its extension when it is already taken. */
export function resolveFilename(
	filename: string,
	existingFiles: string[],
): string {
	if (!existingFiles.includes(filename)) {
		return filename;
	}

	const lastDot = filename.lastIndexOf(".");
	const name = lastDot >= 0 ? filename.substring(0, lastDot) : filename;
	const ext = lastDot >= 0 ? filename.substring(lastDot) : "";
	const timestamp = Date.now();

	return `${name}-${timestamp}${ext}`;
}
