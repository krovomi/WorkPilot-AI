/**
 * L'export de la matrice d'appareils (#383) : une seule image PNG, les
 * captures en grille, chacune sous le nom de son appareil.
 *
 * Les images sont celles que le main a lui-même capturées : le renderer ne
 * fournit aucun pixel. Chaque capture est d'abord réduite à sa case par
 * `nativeImage`, puis la grille est dessinée dans un `<canvas>` d'une fenêtre
 * cachée en bac à sable, sur une page vide (`about:blank`) d'une session en
 * mémoire qui ne navigue nulle part. Les légendes sont écrites par
 * `fillText` : du texte dessiné, jamais du HTML interprété. Ce que la page
 * rend n'est gardé que si c'est un PNG borné.
 */
import { BrowserWindow, nativeImage } from "electron";
import { guardedSession, withTimeout } from "./device-capture";

/** Largeur d'une case, en pixels de l'image exportée. */
export const TILE_WIDTH = 540;
/** Hauteur maximale d'une capture dans sa case : un téléphone très haut est réduit pour y tenir. */
export const MAX_TILE_IMAGE_HEIGHT = 1400;
export const MAX_COLUMNS = 4;
export const GAP = 32;
/** La légende au-dessus de chaque capture : nom de l'appareil, puis taille et bridage. */
export const CAPTION_HEIGHT = 64;
export const COMPOSE_TIMEOUT_MS = 30_000;
/** Au-delà, la réponse de la page n'est pas une grille de dix cases. */
export const MAX_EXPORT_CHARS = 64 * 1024 * 1024;
const PARTITION = "device-matrix-export";

/** Une case : la capture et ses deux lignes de légende. */
export interface GridTile {
	readonly label: string;
	readonly detail: string;
	/** `data:image/png;base64,…`, une capture du main. */
	readonly image: string;
	/** Hauteur / largeur de la fenêtre de l'appareil. */
	readonly aspect: number;
}

export interface GridCell {
	/** La capture, centrée dans sa case. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** Le coin de la légende. */
	readonly captionX: number;
	readonly captionY: number;
}

export interface GridLayout {
	readonly width: number;
	readonly height: number;
	readonly cells: readonly GridCell[];
}

/** Un échec de l'export : le handler le rend en `export-failed`. */
export class GridExportFailure extends Error {
	constructor() {
		super("export-failed");
	}
}

/** La grille : au plus `MAX_COLUMNS` cases par ligne, chaque ligne aussi haute que sa plus haute capture. */
export function layoutGrid(aspects: readonly number[]): GridLayout {
	const columns = Math.max(1, Math.min(MAX_COLUMNS, aspects.length));
	const cells: GridCell[] = [];
	let y = GAP;
	for (let start = 0; start < aspects.length; start += columns) {
		const sized = aspects.slice(start, start + columns).map((aspect) => {
			const height = Math.round(TILE_WIDTH * aspect);
			if (height <= MAX_TILE_IMAGE_HEIGHT) return { width: TILE_WIDTH, height };
			return { width: Math.round((TILE_WIDTH * MAX_TILE_IMAGE_HEIGHT) / height), height: MAX_TILE_IMAGE_HEIGHT };
		});
		sized.forEach((size, index) => {
			const left = GAP + index * (TILE_WIDTH + GAP);
			cells.push({
				x: left + Math.round((TILE_WIDTH - size.width) / 2),
				y: y + CAPTION_HEIGHT,
				width: size.width,
				height: size.height,
				captionX: left,
				captionY: y,
			});
		});
		y += CAPTION_HEIGHT + Math.max(...sized.map((size) => size.height)) + GAP;
	}
	return { width: GAP + columns * (TILE_WIDTH + GAP), height: y, cells };
}

/**
 * Le dessin, sous forme d'expression de fonction : appelé avec la grille et
 * des images déjà réduites par le main, il rend le PNG en `data:`.
 */
export const GRID_COMPOSER = `(async function (input) {
	var canvas = document.createElement("canvas");
	canvas.width = input.layout.width;
	canvas.height = input.layout.height;
	var ctx = canvas.getContext("2d");
	ctx.fillStyle = "#f4f4f5";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.textBaseline = "top";
	for (var i = 0; i < input.tiles.length; i += 1) {
		var tile = input.tiles[i];
		var cell = input.layout.cells[i];
		var img = new Image();
		img.src = tile.image;
		await img.decode();
		ctx.fillStyle = "#18181b";
		ctx.font = "600 22px system-ui, sans-serif";
		ctx.fillText(tile.label, cell.captionX, cell.captionY + 4, input.tileWidth);
		ctx.fillStyle = "#52525b";
		ctx.font = "16px system-ui, sans-serif";
		ctx.fillText(tile.detail, cell.captionX, cell.captionY + 34, input.tileWidth);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
		ctx.drawImage(img, cell.x, cell.y, cell.width, cell.height);
		ctx.strokeStyle = "#d4d4d8";
		ctx.strokeRect(cell.x - 0.5, cell.y - 0.5, cell.width + 1, cell.height + 1);
	}
	return canvas.toDataURL("image/png");
})`;

const PNG_PREFIX = "data:image/png;base64,";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Les octets du PNG rendu par la page, seulement si c'en est un, et borné. */
export function exportedPng(raw: unknown): Buffer | null {
	if (typeof raw !== "string" || raw.length > MAX_EXPORT_CHARS || !raw.startsWith(PNG_PREFIX)) return null;
	const base64 = raw.slice(PNG_PREFIX.length);
	if (!BASE64.test(base64)) return null;
	const bytes = Buffer.from(base64, "base64");
	return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? bytes : null;
}

/** Une capture réduite à la taille de sa case, ou un échec si ce n'est pas une image. */
function shrink(image: string, cell: GridCell): string {
	const source = nativeImage.createFromDataURL(image);
	if (source.isEmpty()) throw new GridExportFailure();
	return source.resize({ width: cell.width, height: cell.height, quality: "best" }).toDataURL();
}

/** La grille des captures, en PNG. */
export async function composeGrid(tiles: readonly GridTile[]): Promise<Buffer> {
	if (tiles.length === 0) throw new GridExportFailure();
	const layout = layoutGrid(tiles.map((tile) => tile.aspect));
	const prepared = tiles.map((tile, index) => ({
		label: tile.label,
		detail: tile.detail,
		image: shrink(tile.image, layout.cells[index]),
	}));
	const win = new BrowserWindow({
		show: false,
		width: 400,
		height: 300,
		webPreferences: {
			session: guardedSession(PARTITION),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
			spellcheck: false,
			backgroundThrottling: false,
		},
	});
	const wc = win.webContents;
	wc.setWindowOpenHandler(() => ({ action: "deny" }));
	wc.on("will-navigate", (event) => event.preventDefault());
	try {
		await wc.loadURL("about:blank");
		const input = JSON.stringify({ layout, tiles: prepared, tileWidth: TILE_WIDTH });
		const raw = await withTimeout(wc.executeJavaScript(`${GRID_COMPOSER}(${input})`), COMPOSE_TIMEOUT_MS);
		const png = exportedPng(raw);
		if (!png) throw new GridExportFailure();
		return png;
	} finally {
		win.destroy();
	}
}
