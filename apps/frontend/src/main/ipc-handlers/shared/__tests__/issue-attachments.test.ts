/**
 * Tests pour les images d'issues GitHub et GitLab.
 *
 * Bout en bout sur un `fetch` simulé : une issue dont le corps cite une image
 * de l'instance, une d'un autre hôte, et l'image atterrit dans `attachments/`.
 * Le jeton ne part que vers l'hôte de l'instance, jamais vers la redirection.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachGitHubIssueImages,
	attachGitLabIssueImages,
	issueImageUrls,
	MAX_ISSUE_IMAGE_BYTES,
	MAX_ISSUE_IMAGES,
	sniffImage,
} from "../issue-attachments";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface Call {
	url: string;
	headers: Record<string, string>;
}

function fakeFetch(
	routes: Record<string, () => Response>,
	calls: Call[],
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({
			url,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		const route = routes[url];
		return route ? route() : new Response("missing", { status: 404 });
	}) as typeof fetch;
}

const dirs: string[] = [];
function specDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "issue-img-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("issueImageUrls", () => {
	it("lit le Markdown et le HTML, résout le relatif, sans doublon", () => {
		const body = [
			"![capture](https://github.com/user-attachments/assets/abc)",
			'<img width="300" src="https://github.com/user-attachments/assets/abc">',
			"![up](/uploads/0123456789abcdef0123456789abcdef/err.png)",
			"![js](javascript:alert(1))",
		].join("\n");
		expect(issueImageUrls(body, "https://gitlab.acme.test/grp/app/")).toEqual([
			"https://github.com/user-attachments/assets/abc",
			"https://gitlab.acme.test/uploads/0123456789abcdef0123456789abcdef/err.png",
		]);
	});

	it("reconnaît une image à ses octets, pas à son nom", () => {
		expect(sniffImage(PNG)?.extension).toBe("png");
		expect(sniffImage(Buffer.from("<html>"))).toBeNull();
	});
});

describe("attachGitHubIssueImages", () => {
	it("écrit l'image de l'issue dans attachments/, le jeton ne quittant pas github.com", async () => {
		const calls: Call[] = [];
		const signed =
			"https://private-user-images.githubusercontent.com/1/abc.png?jwt=x";
		const fetchImpl = fakeFetch(
			{
				"https://github.com/user-attachments/assets/abc": () =>
					new Response(null, { status: 302, headers: { location: signed } }),
				[signed]: () => new Response(PNG),
				"https://github.com/acme/app/assets/2": () =>
					new Response("<html>login</html>"),
			},
			calls,
		);
		const dir = specDir();
		const body = [
			"Voir la capture :",
			"![err](https://github.com/user-attachments/assets/abc)",
			"![ailleurs](https://evil.example.test/steal.png)",
			"![html](https://github.com/acme/app/assets/2)",
		].join("\n");

		const written = await attachGitHubIssueImages("ghp_tok", body, 42, dir, fetchImpl);

		expect(written).toEqual(["github-42-image-1.png"]);
		expect(readdirSync(path.join(dir, "attachments"))).toEqual([
			"github-42-image-1.png",
		]);
		expect(readFileSync(path.join(dir, "attachments", written[0]))).toEqual(PNG);
		const hosts = calls.map((c) => new URL(c.url).host);
		expect(hosts).not.toContain("evil.example.test");
		for (const call of calls) {
			const authorized = Object.keys(call.headers).includes("Authorization");
			expect(authorized).toBe(new URL(call.url).host === "github.com");
		}
	});

	it("plafonne le nombre et la taille, et n'échoue jamais", async () => {
		const routes: Record<string, () => Response> = {};
		const lines: string[] = [];
		for (let i = 0; i < MAX_ISSUE_IMAGES + 3; i++) {
			const url = `https://github.com/user-attachments/assets/${i}`;
			routes[url] = () => new Response(Buffer.concat([PNG, Buffer.from([i])]));
			lines.push(`![${i}](${url})`);
		}
		const big = "https://github.com/user-attachments/assets/big";
		routes[big] = () =>
			new Response(Buffer.concat([PNG, Buffer.alloc(MAX_ISSUE_IMAGE_BYTES)]));
		const boom = "https://github.com/user-attachments/assets/boom";
		routes[boom] = () => {
			throw new Error("reset");
		};
		const dir = specDir();
		const written = await attachGitHubIssueImages(
			"tok",
			[`![b](${big})`, `![x](${boom})`, ...lines].join("\n"),
			7,
			dir,
			fakeFetch(routes, []),
		);
		expect(written).toHaveLength(MAX_ISSUE_IMAGES);
	});
});

describe("attachGitLabIssueImages", () => {
	it("demande un upload par l'API de l'instance, avec PRIVATE-TOKEN", async () => {
		const calls: Call[] = [];
		const secret = "0123456789abcdef0123456789abcdef";
		const api = `https://gitlab.acme.test/api/v4/projects/grp%2Fapp/uploads/${secret}/err.png`;
		const dir = specDir();
		const written = await attachGitLabIssueImages(
			"glpat-tok",
			"https://gitlab.acme.test",
			"grp/app",
			`![err](/uploads/${secret}/err.png)\n![x](https://gitlab.com/uploads/${secret}/x.png)`,
			5,
			dir,
			fakeFetch({ [api]: () => new Response(PNG) }, calls),
		);
		expect(written).toEqual(["gitlab-5-image-1.png"]);
		expect(calls.map((c) => c.url)).toEqual([api]);
		expect(calls[0].headers["PRIVATE-TOKEN"]).toBe("glpat-tok");
	});
});
