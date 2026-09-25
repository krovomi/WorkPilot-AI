/**
 * Tests pour le helper d'inlining des pièces jointes Azure DevOps.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractInlinedImages,
	inlineAzureDevOpsImages,
	saveInlinedImagesAsAttachments,
	isAzureDevOpsAttachmentUrl,
	stripAzureAttachmentImages,
} from "../azure-attachments";

describe("isAzureDevOpsAttachmentUrl", () => {
	it("reconnaît une pièce jointe dev.azure.com", () => {
		const url =
			"https://dev.azure.com/org/proj/_apis/wit/attachments/abc?fileName=a.png";
		expect(isAzureDevOpsAttachmentUrl(url)).toBe(true);
	});

	it("reconnaît un host visualstudio.com", () => {
		const url =
			"https://org.visualstudio.com/_apis/wit/attachments/abc?fileName=a.png";
		expect(isAzureDevOpsAttachmentUrl(url)).toBe(true);
	});

	it("reconnaît le host de l'organisation fourni", () => {
		const url =
			"https://tfs.contoso.local/_apis/wit/attachments/abc?fileName=a.png";
		expect(
			isAzureDevOpsAttachmentUrl(url, "https://tfs.contoso.local/org"),
		).toBe(true);
	});

	it("rejette un host Azure sans chemin de pièce jointe", () => {
		expect(
			isAzureDevOpsAttachmentUrl("https://dev.azure.com/org/proj/_git/repo"),
		).toBe(false);
	});

	it("rejette un host externe", () => {
		const url =
			"https://example.com/_apis/wit/attachments/abc?fileName=a.png";
		expect(isAzureDevOpsAttachmentUrl(url)).toBe(false);
	});

	it("rejette une URL invalide", () => {
		expect(isAzureDevOpsAttachmentUrl("not a url")).toBe(false);
	});
});

describe("inlineAzureDevOpsImages", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retourne le HTML inchangé sans balise img", async () => {
		const html = "<p>pas d'image</p>";
		expect(await inlineAzureDevOpsImages(html, "https://dev.azure.com", "pat")).toBe(
			html,
		);
	});

	it("retourne le HTML inchangé sans PAT", async () => {
		const html =
			'<img src="https://dev.azure.com/o/_apis/wit/attachments/x?fileName=a.png">';
		expect(await inlineAzureDevOpsImages(html, "https://dev.azure.com", "")).toBe(
			html,
		);
	});

	it("inline une pièce jointe Azure en data URI", async () => {
		const src =
			"https://dev.azure.com/o/_apis/wit/attachments/x?fileName=a.png";
		const html = `<img src="${src}">`;
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			headers: { get: () => "image/png" },
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await inlineAzureDevOpsImages(
			html,
			"https://dev.azure.com",
			"pat",
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result).toContain("data:image/png;base64,");
		expect(result).not.toContain(src);
	});

	it("conserve l'URL d'origine si le téléchargement échoue", async () => {
		const src =
			"https://dev.azure.com/o/_apis/wit/attachments/x?fileName=a.png";
		const html = `<img src="${src}">`;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }),
		);

		expect(
			await inlineAzureDevOpsImages(html, "https://dev.azure.com", "pat"),
		).toBe(html);
	});

	it("ignore les images externes (non Azure)", async () => {
		const html = '<img src="https://example.com/a.png">';
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		expect(
			await inlineAzureDevOpsImages(html, "https://dev.azure.com", "pat"),
		).toBe(html);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("stripAzureAttachmentImages", () => {
	it("retire une <img> pointant vers une pièce jointe Azure non inlinée", () => {
		const html =
			'<p>Avant</p><img src="https://dev.azure.com/org/proj/_apis/wit/attachments/abc?fileName=a.png" alt=Image><p>Après</p>';
		const out = stripAzureAttachmentImages(html);
		expect(out).not.toContain("_apis/wit/attachments");
		expect(out).toContain("Avant");
		expect(out).toContain("Après");
	});

	it("conserve les images externes et déjà inlinées (data URI)", () => {
		const html =
			'<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA">';
		expect(stripAzureAttachmentImages(html)).toBe(html);
	});

	it("ne touche pas un HTML sans image", () => {
		const html = "<p>Pas d'image ici</p>";
		expect(stripAzureAttachmentImages(html)).toBe(html);
	});
});

describe("extractInlinedImages", () => {
	const png = Buffer.from("fake-png-bytes").toString("base64");

	it("décode chaque image une seule fois", () => {
		const html = `<p><img src="data:image/png;base64,${png}"><img src="data:image/png;base64,${png}"></p>`;
		const images = extractInlinedImages(html);
		expect(images).toHaveLength(1);
		expect(images[0].extension).toBe("png");
		expect(images[0].data.toString()).toBe("fake-png-bytes");
	});

	it("ignore le SVG et le HTML sans data URI", () => {
		const svg = Buffer.from("<svg/>").toString("base64");
		expect(
			extractInlinedImages(`<img src="data:image/svg+xml;base64,${svg}">`),
		).toEqual([]);
		expect(extractInlinedImages("<p>rien</p>")).toEqual([]);
	});
});

describe("saveInlinedImagesAsAttachments", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("écrit les captures dans attachments/, là où les agents les lisent", () => {
		dir = mkdtempSync(path.join(tmpdir(), "ado-attachments-"));
		const jpeg = Buffer.from("jpeg").toString("base64");
		const png = Buffer.from("png").toString("base64");
		const html = `<img src="data:image/jpeg;base64,${jpeg}"><img src="data:image/png;base64,${png}">`;

		const written = saveInlinedImagesAsAttachments(html, dir, "ado-42");

		expect(written).toEqual(["ado-42-image-1.jpg", "ado-42-image-2.png"]);
		expect(readdirSync(path.join(dir, "attachments")).sort()).toEqual(written);
		expect(
			readFileSync(path.join(dir, "attachments", "ado-42-image-2.png")).toString(),
		).toBe("png");
	});

	it("n'écrit rien quand il n'y a pas d'image", () => {
		dir = mkdtempSync(path.join(tmpdir(), "ado-attachments-"));
		expect(saveInlinedImagesAsAttachments("<p>x</p>", dir, "ado-1")).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
	});
});
