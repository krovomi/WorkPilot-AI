/**
 * @vitest-environment node
 *
 * A server card's published copy, asked of the server by its place in the
 * publication: the renderer's file name never reaches the request, and what
 * the server answers is checked before it reaches the renderer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCapturesSummary } from "../../../shared/types/task-captures";

const server = vi.hoisted(() => ({
	answer: { ok: true, data: {} } as { ok: boolean; data?: unknown; error?: string },
	urls: [] as string[],
}));
vi.mock("../../server-connection", () => ({
	authedFetch: async (url: string) => {
		server.urls.push(url);
		return server.answer;
	},
}));

import { capturePlace, readServerCaptureImage } from "../server-captures";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("img")]);
const side = (file: string) => ({ available: true, status: "clean" as const, kinds: [], passes: [], replaced: 0, file });
const summary = {
	items: [
		{ key: "a", label: "A", platform: "web", variant: "", route: "a", locale: "en", after: side(""), publishable: false },
		{
			key: "b",
			label: "B",
			platform: "web",
			variant: "",
			route: "b",
			locale: "en",
			before: side("captures/published/base/b.png"),
			after: side("captures/published/task/b.png"),
			publishable: true,
		},
	],
} as unknown as TaskCapturesSummary;
const card = { project: { id: "proj 1" }, cardId: "card/2" } as never;

beforeEach(() => {
	server.urls = [];
});

describe("capturePlace", () => {
	it("finds a listed copy's screen and side", () => {
		expect(capturePlace(summary, "captures/published/task/b.png")).toEqual({ index: 1, side: "after" });
		expect(capturePlace(summary, "captures/published/base/b.png")).toEqual({ index: 1, side: "before" });
	});

	it("names nothing for an unlisted or unsafe file", () => {
		for (const file of ["captures/published/task/c.png", "../b.png", "", 3, "captures/published/task/../b.png"]) {
			expect(capturePlace(summary, file)).toBeNull();
		}
	});
});

describe("readServerCaptureImage", () => {
	it("asks for the place, every part encoded, and returns the image", async () => {
		server.answer = { ok: true, data: { mimeType: "image/png", data: PNG.toString("base64") } };
		expect(await readServerCaptureImage(card, summary, "captures/published/base/b.png")).toEqual({
			base64: PNG.toString("base64"),
		});
		expect(server.urls).toEqual(["/api/board/cards/card%2F2/captures/1/before?project_id=proj%201"]);
	});

	it("asks nothing for an unlisted file", async () => {
		expect(await readServerCaptureImage(card, summary, "secret.png")).toEqual({ error: "not-listed" });
		expect(server.urls).toEqual([]);
	});

	it("passes on a refusal and refuses an answer that is not a PNG", async () => {
		const file = "captures/published/task/b.png";
		server.answer = { ok: false, error: "Capture not found" };
		expect(await readServerCaptureImage(card, summary, file)).toEqual({ error: "Capture not found" });
		server.answer = { ok: true, data: { data: "" } };
		expect(await readServerCaptureImage(card, summary, file)).toEqual({ error: "unreadable" });
		server.answer = { ok: true, data: null };
		expect(await readServerCaptureImage(card, summary, file)).toEqual({ error: "unreadable" });
		server.answer = { ok: true, data: { data: Buffer.from("GIF89a").toString("base64") } };
		expect(await readServerCaptureImage(card, summary, file)).toEqual({ error: "not-png" });
		server.answer = { ok: true, data: { data: "A".repeat(21 * 1024 * 1024) } };
		expect(await readServerCaptureImage(card, summary, file)).toEqual({ error: "too-large" });
	});
});
