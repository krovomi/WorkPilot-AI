/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	blobToBase64,
	createThumbnail,
	generateImageId,
	isValidImageMimeType,
	resolveFilename,
} from "../image-attachments";

describe("generateImageId", () => {
	it("gives a different img- id each time", () => {
		const a = generateImageId();
		const b = generateImageId();
		expect(a).toMatch(/^img-\d+-[a-z0-9]+$/);
		expect(a).not.toBe(b);
	});
});

describe("isValidImageMimeType", () => {
	it("accepts the image types and refuses the rest", () => {
		expect(isValidImageMimeType("image/png")).toBe(true);
		expect(isValidImageMimeType("image/jpeg")).toBe(true);
		expect(isValidImageMimeType("application/pdf")).toBe(false);
		expect(isValidImageMimeType("")).toBe(false);
	});
});

describe("blobToBase64", () => {
	it("reads a blob as a data URL", async () => {
		await expect(
			blobToBase64(new Blob(["hi"], { type: "text/plain" })),
		).resolves.toBe("data:text/plain;base64,aGk=");
	});

	it("rejects when the reader fails", async () => {
		const original = FileReader.prototype.readAsDataURL;
		FileReader.prototype.readAsDataURL = function (this: FileReader) {
			this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
		};
		try {
			await expect(blobToBase64(new Blob(["x"]))).rejects.toBeInstanceOf(
				ProgressEvent,
			);
		} finally {
			FileReader.prototype.readAsDataURL = original;
		}
	});
});

describe("createThumbnail", () => {
	const drawn: Array<[number, number]> = [];

	function stubImage(width: number, height: number, fails = false) {
		class FakeImage {
			width = width;
			height = height;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_value: string) {
				queueMicrotask(() => (fails ? this.onerror?.() : this.onload?.()));
			}
		}
		vi.stubGlobal("Image", FakeImage);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: (_img: unknown, _x: number, _y: number, w: number, h: number) =>
				drawn.push([w, h]),
		} as unknown as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
			"data:image/jpeg;base64,thumb",
		);
	}

	afterEach(() => {
		drawn.length = 0;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([
		["a wide image to its width", 400, 100, [200, 50]],
		["a tall image to its height", 100, 400, [50, 200]],
		["a small image as it is", 120, 80, [120, 80]],
		["a small tall image as it is", 80, 120, [80, 120]],
	])("scales %s", async (_label, width, height, expected) => {
		stubImage(width, height);

		await expect(createThumbnail("data:image/png;base64,x")).resolves.toBe(
			"data:image/jpeg;base64,thumb",
		);
		expect(drawn).toEqual([expected]);
	});

	it("still encodes when the canvas has no 2D context", async () => {
		stubImage(10, 10);
		vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);

		await expect(createThumbnail("data:image/png;base64,x")).resolves.toBe(
			"data:image/jpeg;base64,thumb",
		);
		expect(drawn).toEqual([]);
	});

	it("gives back the original when the image cannot be decoded", async () => {
		stubImage(10, 10, true);

		await expect(createThumbnail("data:image/png;base64,bad")).resolves.toBe(
			"data:image/png;base64,bad",
		);
		expect(drawn).toEqual([]);
	});
});

describe("resolveFilename", () => {
	afterEach(() => vi.useRealTimers());

	it("keeps a free name and stamps a taken one before its extension", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);

		expect(resolveFilename("a.png", ["b.png"])).toBe("a.png");
		expect(resolveFilename("a.png", ["a.png"])).toBe("a-1700000000000.png");
		expect(resolveFilename("README", ["README"])).toBe("README-1700000000000");
	});
});
