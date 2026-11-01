/**
 * Images attached to a new card, checked on the phone with the server's rules
 * (`shared_board/attachments.py`): at most ten, PNG, JPEG, GIF or WebP by their
 * bytes (not by the name or the type the picker claims), at most 5 MB each.
 * An image that breaks a rule is refused with its reason, never dropped
 * silently; the server checks them all again.
 */

export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 5_000_000;
const MAX_FILENAME = 120;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type RefusalReason = "tooMany" | "tooLarge" | "unsupported" | "unreadable";

/** What the picker hands back, reduced to what is used (`ImagePickerAsset`). */
export interface PickedAsset {
	uri: string;
	base64?: string | null;
	fileName?: string | null;
}

export interface PendingImage {
	id: string;
	uri: string;
	filename: string;
	mimeType: ImageMime;
	/** Base64, as the server takes it. */
	data: string;
}

export interface Refusal {
	name: string;
	reason: RefusalReason;
}

const EXTENSIONS: Record<ImageMime, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** The value of a base64 character, or -1 for padding and anything else. */
function sextet(char: string): number {
	const code = char.charCodeAt(0);
	if (code >= 65 && code <= 90) return code - 65; // A-Z
	if (code >= 97 && code <= 122) return code - 71; // a-z
	if (code >= 48 && code <= 57) return code + 4; // 0-9
	if (char === "+") return 62;
	if (char === "/") return 63;
	return -1;
}

/** The first bytes of a base64 string, decoded by hand (no `atob` on every runtime). */
export function leadingBytes(base64: string, count = 12): number[] {
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const char of base64) {
		const value = sextet(char);
		if (value < 0) break;
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
			if (bytes.length >= count) break;
		}
	}
	return bytes;
}

/** The image type its bytes say, or `null` for anything else (HEIC, SVG, a video...). */
export function sniffMime(base64: string): ImageMime | null {
	const b = leadingBytes(base64);
	const starts = (sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts([0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
	return null;
}

/** How many bytes a base64 string decodes to. */
export function decodedSize(base64: string): number {
	const clean = base64.replace(/\s/g, "");
	const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
	return Math.floor((clean.length * 3) / 4) - padding;
}

function filenameFor(asset: PickedAsset, mime: ImageMime, index: number): string {
	const raw = (asset.fileName ?? "").split(/[\\/]/).pop() ?? "";
	const name = raw.replace(/[^A-Za-z0-9._ -]+/g, "_").trim();
	return (name || `image-${index + 1}.${EXTENSIONS[mime]}`).slice(-MAX_FILENAME);
}

function displayName(asset: PickedAsset, index: number): string {
	return (asset.fileName ?? "").split(/[\\/]/).pop() || `#${index + 1}`;
}

function refusalFor(data: string, mime: ImageMime | null, attached: number): RefusalReason | null {
	if (!data) return "unreadable";
	if (!mime) return "unsupported";
	if (decodedSize(data) > MAX_IMAGE_BYTES) return "tooLarge";
	if (attached >= MAX_IMAGES) return "tooMany";
	return null;
}

let counter = 0;

/**
 * Add what the picker returned to the images already attached: each kept
 * image, and each refused one with why.
 */
export function addImages(
	current: readonly PendingImage[],
	assets: readonly PickedAsset[],
): { images: PendingImage[]; refused: Refusal[] } {
	const images = [...current];
	const refused: Refusal[] = [];
	for (const [index, asset] of assets.entries()) {
		const name = displayName(asset, index);
		const data = asset.base64?.replace(/\s/g, "") ?? "";
		const mime = data ? sniffMime(data) : null;
		const reason = refusalFor(data, mime, images.length);
		if (reason || !mime) {
			refused.push({ name, reason: reason ?? "unsupported" });
			continue;
		}
		counter += 1;
		images.push({
			id: `img-${counter}`,
			uri: asset.uri,
			filename: filenameFor(asset, mime, images.length),
			mimeType: mime,
			data,
		});
	}
	return { images, refused };
}

/** The `attachments` field of `createCard`. */
export function attachmentsPayload(images: readonly PendingImage[]) {
	return images.map(({ filename, mimeType, data }) => ({ filename, mimeType, data }));
}
