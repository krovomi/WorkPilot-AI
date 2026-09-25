/**
 * Tests pour le téléchargement des pièces jointes images Jira.
 *
 * Deux propriétés comptent : les identifiants ne partent que vers l'instance
 * configurée, et un échec coûte des images, jamais l'import.
 */
import { describe, expect, it, vi } from "vitest";
import {
	downloadJiraImageAttachments,
	MAX_JIRA_IMAGE_BYTES,
	selectImageAttachments,
} from "../jira-attachments";

const BASE = "https://acme.atlassian.net";
const credentials = { instanceUrl: BASE, email: "a@b.c", apiToken: "tok" };

function attachment(overrides: Record<string, unknown> = {}) {
	return {
		filename: "error.png",
		mimeType: "image/png",
		size: 10,
		content: `${BASE}/rest/api/2/attachment/content/1`,
		...overrides,
	};
}

describe("selectImageAttachments", () => {
	it("garde les images de l'instance, sous le plafond", () => {
		const selected = selectImageAttachments(
			{
				fields: {
					attachment: [
						attachment(),
						attachment({ filename: "spec.pdf", mimeType: "application/pdf" }),
						attachment({ filename: "huge.png", size: MAX_JIRA_IMAGE_BYTES + 1 }),
						attachment({
							filename: "elsewhere.png",
							content: "https://evil.example.com/x.png",
						}),
					],
				},
			},
			BASE,
		);
		expect(selected.map((a) => a.filename)).toEqual(["error.png"]);
	});

	it("tolère une réponse sans pièce jointe", () => {
		expect(selectImageAttachments({}, BASE)).toEqual([]);
		expect(selectImageAttachments(null, BASE)).toEqual([]);
	});
});

describe("downloadJiraImageAttachments", () => {
	function fakeFetch(files: Record<string, string>, list: unknown[]) {
		return vi.fn(async (url: string, init?: RequestInit) => {
			expect(new URL(url).host).toBe("acme.atlassian.net");
			expect(
				(init?.headers as Record<string, string> | undefined)?.Authorization,
			).toMatch(/^Basic /);
			if (url.includes("?fields=attachment")) {
				return new Response(JSON.stringify({ fields: { attachment: list } }));
			}
			const body = files[url];
			return body === undefined
				? new Response("", { status: 404 })
				: new Response(body);
		}) as unknown as typeof fetch;
	}

	it("renvoie les images en pièces jointes de tâche, noms uniques", async () => {
		const first = `${BASE}/rest/api/2/attachment/content/1`;
		const second = `${BASE}/rest/api/2/attachment/content/2`;
		const fetchImpl = fakeFetch({ [first]: "one", [second]: "two" }, [
			attachment({ content: first }),
			attachment({ content: second }),
		]);

		const images = await downloadJiraImageAttachments(
			credentials,
			"PROJ-12",
			fetchImpl,
		);

		expect(images.map((i) => i.filename)).toEqual([
			"PROJ-12-error.png",
			"PROJ-12-error-2.png",
		]);
		expect(Buffer.from(images[1].data ?? "", "base64").toString()).toBe("two");
		expect(images[0].mimeType).toBe("image/png");
	});

	it("un téléchargement raté coûte l'image, pas le reste", async () => {
		const ok = `${BASE}/rest/api/2/attachment/content/2`;
		const fetchImpl = fakeFetch({ [ok]: "two" }, [
			attachment({ content: `${BASE}/rest/api/2/attachment/content/1` }),
			attachment({ filename: "mockup.png", content: ok }),
		]);
		const images = await downloadJiraImageAttachments(
			credentials,
			"PROJ-12",
			fetchImpl,
		);
		expect(images.map((i) => i.filename)).toEqual(["PROJ-12-mockup.png"]);
	});

	it("refuse une clé qui n'en est pas une, sans appel réseau", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		expect(
			await downloadJiraImageAttachments(credentials, "../../admin", fetchImpl),
		).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("une instance injoignable donne une liste vide", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(
			await downloadJiraImageAttachments(credentials, "PROJ-1", fetchImpl),
		).toEqual([]);
	});
});
