import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	LINUX_OPENERS,
	openExternalUrl,
	parseExternalUrl,
} from "./open-external";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

/** Un faux processus d'ouvreur dont on choisit le verdict. */
function fakeOpener(outcome: "ok" | "missing" | "refused") {
	const child = new EventEmitter() as EventEmitter & { unref: () => void };
	child.unref = () => undefined;
	queueMicrotask(() => {
		if (outcome === "missing") child.emit("error", new Error("ENOENT"));
		else child.emit("exit", outcome === "ok" ? 0 : 3);
	});
	return child as never;
}

describe("parseExternalUrl", () => {
	it("distingue une URL illisible d'un schéma refusé", () => {
		expect(parseExternalUrl("https://example.com/x").host).toBe("example.com");
		expect(() => parseExternalUrl("pas une url")).toThrow(/Invalid URL format/);
		expect(() => parseExternalUrl("file:///etc/passwd")).toThrow(
			/Unsafe URL protocol: file:/,
		);
		expect(() => parseExternalUrl("javascript:alert(1)")).toThrow(
			/Unsafe URL protocol/,
		);
	});
});

describe("openExternalUrl", () => {
	it("s'arrête au premier succès, sans lancer de processus", async () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		const spawnOpener = vi.fn();
		await openExternalUrl("http://localhost:5000/swagger", {
			openExternal,
			linux: true,
			spawnOpener,
		});
		expect(openExternal).toHaveBeenCalledWith("http://localhost:5000/swagger");
		expect(spawnOpener).not.toHaveBeenCalled();
	});

	it("remonte l'échec tel quel hors de Linux", async () => {
		const spawnOpener = vi.fn();
		await expect(
			openExternalUrl("https://example.com", {
				openExternal: vi.fn().mockRejectedValue(new Error("no handler")),
				linux: false,
				spawnOpener,
			}),
		).rejects.toThrow("no handler");
		expect(spawnOpener).not.toHaveBeenCalled();
	});

	it("essaie les ouvreurs Linux jusqu'à celui qui répond", async () => {
		const spawnOpener = vi
			.fn()
			.mockImplementationOnce(() => fakeOpener("missing"))
			.mockImplementationOnce(() => fakeOpener("refused"))
			.mockImplementationOnce(() => fakeOpener("ok"));
		await openExternalUrl("http://localhost:5000/", {
			openExternal: vi.fn().mockRejectedValue(new Error("portal unavailable")),
			linux: true,
			spawnOpener,
		});
		expect(spawnOpener).toHaveBeenCalledTimes(3);
		expect(spawnOpener).toHaveBeenNthCalledWith(1, "xdg-open", [
			"http://localhost:5000/",
		]);
		// `gio` porte un sous-commande, que l'URL suit.
		expect(spawnOpener).toHaveBeenNthCalledWith(2, "gio", [
			"open",
			"http://localhost:5000/",
		]);
	});

	it("nomme ce qui a été essayé quand rien n'ouvre", async () => {
		const spawnOpener = vi.fn(() => fakeOpener("missing"));
		await expect(
			openExternalUrl("http://localhost:5000/", {
				openExternal: vi.fn().mockRejectedValue(new Error("xdg-open missing")),
				linux: true,
				spawnOpener,
			}),
		).rejects.toThrow(/xdg-open missing[\s\S]*Tried: xdg-open, gio/);
		expect(spawnOpener).toHaveBeenCalledTimes(LINUX_OPENERS.length);
	});

	it("refuse le schéma avant d'essayer quoi que ce soit", async () => {
		const openExternal = vi.fn();
		await expect(
			openExternalUrl("file:///etc/passwd", {
				openExternal,
				linux: true,
				spawnOpener: vi.fn(),
			}),
		).rejects.toThrow(/Unsafe URL protocol/);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("survit à un spawn qui lève", async () => {
		const spawnOpener = vi.fn(() => {
			throw new Error("EACCES");
		});
		await expect(
			openExternalUrl("http://localhost:5000/", {
				openExternal: vi.fn().mockRejectedValue(new Error("nope")),
				linux: true,
				spawnOpener: spawnOpener as never,
			}),
		).rejects.toThrow(/Unable to open/);
	});
});
