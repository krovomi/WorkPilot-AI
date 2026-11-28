/**
 * @vitest-environment jsdom
 */
/**
 * Exporting the device matrix (#383): the main's own captures, shrunk to
 * their cells and drawn on a canvas of a hidden sandboxed blank page that
 * goes nowhere; labels are drawn text; only a bounded PNG comes back, or a
 * bounded PDF printed from that PNG alone. Faulty elements can be boxed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const PDF_PAGE_START = "(function (src, width, height)";

const state = vi.hoisted(() => ({
	windows: [] as FakeWindow[],
	run: (async () => "") as (code: string) => Promise<unknown>,
	empty: false,
	resized: [] as unknown[],
	printed: (async () => Buffer.from("%PDF-1.7\n")) as () => Promise<unknown>,
	printOptions: [] as unknown[],
	codes: [] as string[],
}));

interface FakeWindow {
	options: Record<string, unknown>;
	destroy: ReturnType<typeof vi.fn>;
	loaded?: string;
	code?: string;
	openHandler?: () => unknown;
	listeners: Record<string, (event: { preventDefault: () => void }) => void>;
}

vi.mock("electron", () => {
	class BrowserWindow {
		webContents: Record<string, unknown>;
		destroy = vi.fn();
		constructor(options: Record<string, unknown>) {
			const record: FakeWindow = { options, destroy: this.destroy, listeners: {} };
			state.windows.push(record);
			this.webContents = {
				setWindowOpenHandler: (handler: () => unknown) => {
					record.openHandler = handler;
				},
				on: (name: string, listener: FakeWindow["listeners"][string]) => {
					record.listeners[name] = listener;
				},
				loadURL: async (url: string) => {
					record.loaded = url;
				},
				executeJavaScript: (code: string) => {
					state.codes.push(code);
					if (code.startsWith(PDF_PAGE_START)) return Promise.resolve(true);
					record.code = code;
					return state.run(code);
				},
				printToPDF: (options: unknown) => {
					state.printOptions.push(options);
					return state.printed();
				},
			};
		}
	}
	const fakeSession = {
		setPermissionRequestHandler: vi.fn(),
		setPermissionCheckHandler: vi.fn(),
		on: vi.fn(),
	};
	const nativeImage = {
		createFromDataURL: (url: string) => ({
			isEmpty: () => state.empty,
			resize: (options: unknown) => {
				state.resized.push(options);
				return { toDataURL: () => `${url}#small` };
			},
		}),
	};
	return { BrowserWindow, nativeImage, session: { fromPartition: vi.fn(() => fakeSession) } };
});

import {
	CAPTION_HEIGHT,
	COMPOSE_TIMEOUT_MS,
	GAP,
	GRID_COMPOSER,
	GridExportFailure,
	MAX_COLUMNS,
	MAX_EXPORT_CHARS,
	MAX_PDF_BYTES,
	MAX_TILE_IMAGE_HEIGHT,
	PDF_PAGE,
	TILE_WIDTH,
	composeGrid,
	exportedPdf,
	exportedPng,
	layoutGrid,
} from "../grid-export";
import type { IssueMarker } from "../../../shared/utils/issue-markers";

const tile = (label: string, aspect = 2, markers: IssueMarker[] = []) => ({
	label,
	detail: "393 × 852 @3x",
	image: PNG,
	aspect,
	markers,
});
const lastWindow = () => state.windows[state.windows.length - 1];

describe("layoutGrid", () => {
	it("puts one capture in one cell under its caption", () => {
		const layout = layoutGrid([0.5]);
		expect(layout.width).toBe(GAP + TILE_WIDTH + GAP);
		expect(layout.cells).toEqual([
			{ x: GAP, y: GAP + CAPTION_HEIGHT, width: TILE_WIDTH, height: TILE_WIDTH / 2, captionX: GAP, captionY: GAP },
		]);
		expect(layout.height).toBe(GAP + CAPTION_HEIGHT + TILE_WIDTH / 2 + GAP);
	});

	it("wraps after MAX_COLUMNS, each row as tall as its tallest capture", () => {
		const layout = layoutGrid([2, 1, 0.5, 0.5, 1]);
		expect(layout.width).toBe(GAP + MAX_COLUMNS * (TILE_WIDTH + GAP));
		const secondRow = GAP + CAPTION_HEIGHT + TILE_WIDTH * 2 + GAP;
		expect(layout.cells[4]).toMatchObject({ x: GAP, captionY: secondRow, y: secondRow + CAPTION_HEIGHT });
		expect(layout.cells[1].x).toBe(GAP + TILE_WIDTH + GAP);
		expect(layout.height).toBe(secondRow + CAPTION_HEIGHT + TILE_WIDTH + GAP);
	});

	it("shrinks a very tall capture to fit, centred in its cell", () => {
		const [cell] = layoutGrid([3]).cells;
		expect(cell.height).toBe(MAX_TILE_IMAGE_HEIGHT);
		expect(cell.width).toBe(Math.round((TILE_WIDTH * MAX_TILE_IMAGE_HEIGHT) / (TILE_WIDTH * 3)));
		expect(cell.x).toBe(GAP + Math.round((TILE_WIDTH - cell.width) / 2));
	});

	it("lays out nothing for no capture", () => {
		expect(layoutGrid([])).toEqual({ width: GAP + TILE_WIDTH + GAP, height: GAP, cells: [] });
	});
});

describe("exportedPng", () => {
	it("keeps a PNG, and only a bounded one", () => {
		expect(exportedPng(PNG)?.subarray(1, 4).toString()).toBe("PNG");
		expect(exportedPng(42)).toBeNull();
		expect(exportedPng("data:image/jpeg;base64,/9j/4AAQ")).toBeNull();
		expect(exportedPng("data:image/png;base64,<script>")).toBeNull();
		expect(exportedPng("data:image/png;base64,R0lGODlh")).toBeNull();
		expect(exportedPng(`data:image/png;base64,${"A".repeat(MAX_EXPORT_CHARS)}`)).toBeNull();
	});
});

describe("exportedPdf", () => {
	it("keeps a PDF, and only a bounded one", () => {
		expect(exportedPdf(Buffer.from("%PDF-1.7 x"))?.length).toBe(10);
		expect(exportedPdf("%PDF-1.7")).toBeNull();
		expect(exportedPdf(Buffer.from("<html>"))).toBeNull();
		const huge = Buffer.alloc(MAX_PDF_BYTES + 1);
		huge.write("%PDF-");
		expect(exportedPdf(huge)).toBeNull();
	});
});

describe("composeGrid", () => {
	beforeEach(() => {
		state.windows = [];
		state.run = async () => PNG;
		state.empty = false;
		state.resized = [];
		state.printed = async () => Buffer.from("%PDF-1.7\n");
		state.printOptions = [];
		state.codes = [];
	});

	it("hands the composer only the numbers of each marker", async () => {
		const marker = { kind: "small-text", selector: "p.tiny", x: 0.1, y: 0.2, width: 0.3, height: 0.05 } as const;
		await composeGrid([tile("iPhone 15", 2, [marker])]);
		const input = JSON.parse((lastWindow().code ?? "").slice(GRID_COMPOSER.length + 1, -1));
		expect(input.tiles[0].markers).toEqual([{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }]);
	});

	it("prints the PNG alone on one page of its size for a PDF", async () => {
		const pdf = await composeGrid([tile("iPhone 15")], "pdf");
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		const layout = layoutGrid([2]);
		const page = state.codes.find((code) => code.startsWith(PDF_PAGE));
		expect(page).toBeDefined();
		const args = JSON.parse((page ?? "").slice(PDF_PAGE.length + 4, -1));
		expect(args[0]).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
		expect(args.slice(1)).toEqual([layout.width, layout.height]);
		expect(state.printOptions).toEqual([
			{
				printBackground: true,
				margins: { top: 0, bottom: 0, left: 0, right: 0 },
				pageSize: { width: layout.width / 96, height: layout.height / 96 },
				pageRanges: "1",
			},
		]);
		expect(lastWindow().destroy).toHaveBeenCalled();
	});

	it("refuses a print that is not a PDF", async () => {
		state.printed = async () => Buffer.from("<html>");
		await expect(composeGrid([tile("iPhone 15")], "pdf")).rejects.toBeInstanceOf(GridExportFailure);
		expect(lastWindow().destroy).toHaveBeenCalled();
	});

	it("draws the shrunk captures in a hidden sandboxed blank page that goes nowhere", async () => {
		const png = await composeGrid([tile("iPhone 15"), tile("Ordinateur Full HD", 0.5625)]);
		expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const window = lastWindow();
		expect(window.options).toMatchObject({ show: false });
		expect(window.options.webPreferences).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
		});
		expect(window.options.webPreferences).not.toHaveProperty("preload");
		expect(window.loaded).toBe("about:blank");
		expect(window.openHandler?.()).toEqual({ action: "deny" });
		const away = { preventDefault: vi.fn() };
		window.listeners["will-navigate"](away);
		expect(away.preventDefault).toHaveBeenCalled();
		expect(state.resized).toEqual([
			{ width: TILE_WIDTH, height: TILE_WIDTH * 2, quality: "best" },
			{ width: TILE_WIDTH, height: Math.round(TILE_WIDTH * 0.5625), quality: "best" },
		]);
		expect(window.code?.startsWith(GRID_COMPOSER)).toBe(true);
		const input = JSON.parse((window.code ?? "").slice(GRID_COMPOSER.length + 1, -1));
		expect(input.tiles.map((entry: { label: string; image: string }) => [entry.label, entry.image])).toEqual([
			["iPhone 15", `${PNG}#small`],
			["Ordinateur Full HD", `${PNG}#small`],
		]);
		expect(window.destroy).toHaveBeenCalled();
	});

	it("refuses no capture, a capture that is not an image, and an answer that is not a PNG", async () => {
		await expect(composeGrid([])).rejects.toBeInstanceOf(GridExportFailure);
		state.empty = true;
		await expect(composeGrid([tile("iPhone 15")])).rejects.toBeInstanceOf(GridExportFailure);
		state.empty = false;
		state.run = async () => "data:text/html;base64,PGI+";
		await expect(composeGrid([tile("iPhone 15")])).rejects.toBeInstanceOf(GridExportFailure);
		expect(lastWindow().destroy).toHaveBeenCalled();
	});

	it("gives up on a drawing that never ends, and still destroys the window", async () => {
		vi.useFakeTimers();
		try {
			state.run = () => new Promise(() => undefined);
			const pending = composeGrid([tile("iPhone 15")]);
			const refused = expect(pending).rejects.toThrow("timeout");
			await vi.advanceTimersByTimeAsync(COMPOSE_TIMEOUT_MS);
			await refused;
			expect(lastWindow().destroy).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("PDF_PAGE", () => {
	it("shows the image alone, at its size, without margins", async () => {
		class FakeImage {
			width = 0;
			height = 0;
			src = "";
			decode() {
				return Promise.resolve();
			}
		}
		const appended: unknown[] = [];
		vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
			appended.push(node);
			return node;
		});
		vi.stubGlobal("Image", FakeImage);
		try {
			const run = (window as unknown as { eval: (code: string) => Promise<boolean> }).eval(
				`${PDF_PAGE}(${JSON.stringify(PNG)}, 640, 480)`,
			);
			expect(await run).toBe(true);
			expect(appended).toEqual([expect.objectContaining({ src: PNG, width: 640, height: 480 })]);
			expect(document.head.querySelector("style")?.textContent).toContain("@page { margin: 0 }");
		} finally {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		}
	});
});

describe("GRID_COMPOSER", () => {
	it("draws each caption as text and each capture in its cell, then hands back a PNG", async () => {
		const calls: [string, ...unknown[]][] = [];
		const context = new Proxy(
			{},
			{
				get: (_target, name: string) => (...args: unknown[]) => calls.push([name, ...args]),
				set: (_target, name: string, value: unknown) => {
					calls.push([`set ${name}`, value]);
					return true;
				},
			},
		);
		const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: (type: string) => `${type}:grid` };
		const create = document.createElement.bind(document);
		const fakeCreate = (tag: string) => (tag === "canvas" ? (canvas as unknown as HTMLElement) : create(tag));
		vi.spyOn(document, "createElement").mockImplementation(fakeCreate as typeof document.createElement);
		const decoded: string[] = [];
		class FakeImage {
			src = "";
			decode() {
				decoded.push(this.src);
				return Promise.resolve();
			}
		}
		vi.stubGlobal("Image", FakeImage);
		try {
			const layout = layoutGrid([2]);
			const markers = [{ x: 0.5, y: 0.25, width: 0.1, height: 0.1 }];
			const input = {
				layout,
				tiles: [{ label: "<b>iPhone</b>", detail: "Slow 3G", image: PNG, markers }],
				tileWidth: TILE_WIDTH,
			};
			const run = (window as unknown as { eval: (code: string) => Promise<string> }).eval(
				`${GRID_COMPOSER}(${JSON.stringify(input)})`,
			);
			expect(await run).toBe("image/png:grid");
			expect([canvas.width, canvas.height]).toEqual([layout.width, layout.height]);
			expect(decoded).toEqual([PNG]);
			const texts = calls.filter(([name]) => name === "fillText").map(([, text]) => text);
			expect(texts).toEqual(["<b>iPhone</b>", "Slow 3G"]);
			const [cell] = layout.cells;
			expect(calls).toContainEqual(["drawImage", expect.any(FakeImage), cell.x, cell.y, cell.width, cell.height]);
			expect(calls).toContainEqual([
				"strokeRect",
				cell.x + 0.5 * cell.width,
				cell.y + 0.25 * cell.height,
				0.1 * cell.width,
				0.1 * cell.height,
			]);
		} finally {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		}
	});
});
