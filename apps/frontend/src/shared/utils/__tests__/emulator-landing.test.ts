import { describe, expect, it } from "vitest";
import {
	buildLandingUrl,
	deriveLandingCandidates,
	deriveLandingPath,
	normalizeLandingPath,
	resolveAddressInput,
	routeFromFilePath,
} from "../emulator-landing";

/** Construit un patch git minimal à partir des lignes ajoutées. */
function patch(...lines: string[]): string {
	return ["@@ -0,0 +1 @@", ...lines.map((line) => `+${line}`)].join("\n");
}

describe("deriveLandingPath — déclarations de routes", () => {
	it("substitue [controller] au nom de la classe ASP.NET", () => {
		const guess = deriveLandingPath([
			{
				path: "src/Rag.Api/Controllers/DocumentsController.cs",
				patch: patch(
					"[ApiController]",
					'[Route("api/[controller]")]',
					"public class DocumentsController : ControllerBase",
				),
			},
		]);
		expect(guess).toEqual({
			path: "/api/documents",
			source: "route-declaration",
			file: "src/Rag.Api/Controllers/DocumentsController.cs",
		});
	});

	it("retombe sur le nom du fichier quand la classe n'est pas dans le patch", () => {
		const guess = deriveLandingPath([
			{
				path: "src/Api/Controllers/NamespacesController.cs",
				patch: patch('[Route("api/[controller]")]'),
			},
		]);
		expect(guess?.path).toBe("/api/namespaces");
	});

	it("coupe la route au premier segment dynamique", () => {
		const guess = deriveLandingPath([
			{
				path: "src/Api/Controllers/UsersController.cs",
				patch: patch('[Route("api/users/{id:int}/roles")]'),
			},
		]);
		expect(guess?.path).toBe("/api/users");
	});

	it("lit une Minimal API .NET", () => {
		const guess = deriveLandingPath([
			{
				path: "src/Api/Program.cs",
				patch: patch('app.MapGet("/health", () => Results.Ok());'),
			},
		]);
		expect(guess?.path).toBe("/health");
	});

	it("lit un contrôleur NestJS et une route Express", () => {
		expect(
			deriveLandingPath([
				{ path: "src/documents/documents.controller.ts", patch: patch("@Controller('documents')") },
			])?.path,
		).toBe("/documents");
		expect(
			deriveLandingPath([
				{ path: "server/api.js", patch: patch('app.get("/api/reports", handler);') },
			])?.path,
		).toBe("/api/reports");
	});

	it("lit une Route React et une route Angular", () => {
		expect(
			deriveLandingPath([
				{ path: "src/App.tsx", patch: patch('<Route path="/settings" element={<Settings />} />') },
			])?.path,
		).toBe("/settings");
		expect(
			deriveLandingPath([
				{
					path: "src/app/app-routing.module.ts",
					patch: patch("{ path: 'invoices', component: InvoicesComponent },"),
				},
			])?.path,
		).toBe("/invoices");
	});

	it("ignore `path:` hors d'un fichier de routes", () => {
		expect(
			deriveLandingCandidates([
				{ path: "src/config/build.ts", patch: patch("{ path: 'dist/assets' }") },
			]),
		).toEqual([]);
	});

	it("lit FastAPI, Django et Spring", () => {
		expect(
			deriveLandingPath([{ path: "app/main.py", patch: patch('@app.get("/items")') }])?.path,
		).toBe("/items");
		expect(
			deriveLandingPath([
				{ path: "project/urls.py", patch: patch('path("reports/", views.reports),') },
			])?.path,
		).toBe("/reports");
		expect(
			deriveLandingPath([
				{
					path: "src/main/java/app/OrderController.java",
					patch: patch('@RequestMapping("/orders")'),
				},
			])?.path,
		).toBe("/orders");
	});

	it("ignore une URL absolue trouvée dans une déclaration", () => {
		expect(
			deriveLandingCandidates([
				{ path: "src/app.ts", patch: patch('app.use("https://cdn.example.com/assets")') },
			]),
		).toEqual([]);
	});

	it("ne lit que les lignes ajoutées", () => {
		const removed = ["@@ -1 +0,0 @@", '-[Route("api/legacy")]'].join("\n");
		expect(
			deriveLandingCandidates([
				{ path: "src/Api/Controllers/LegacyController.cs", patch: removed },
			]),
		).toEqual([]);
	});
});

describe("routeFromFilePath — conventions de nommage", () => {
	it.each([
		["apps/web/app/dashboard/page.tsx", "/dashboard"],
		["app/(marketing)/pricing/page.tsx", "/pricing"],
		["pages/reports/index.tsx", "/reports"],
		["pages/about.vue", "/about"],
		["src/routes/blog/+page.svelte", "/blog"],
		["app/routes/invoices.new.tsx", "/invoices/new"],
	])("%s → %s", (filePath, expected) => {
		expect(routeFromFilePath(filePath)).toBe(expected);
	});

	it("s'arrête avant un segment dynamique", () => {
		expect(routeFromFilePath("app/users/[id]/page.tsx")).toBe("/users");
	});

	it("rend null pour un fichier qui n'est pas une page", () => {
		expect(routeFromFilePath("src/components/Button.tsx")).toBeNull();
	});
});

describe("deriveLandingCandidates — ordre et repli", () => {
	it("préfère une route déclarée à une page conventionnelle", () => {
		const candidates = deriveLandingCandidates([
			{ path: "app/reports/page.tsx" },
			{ path: "src/Api/Controllers/ReportsController.cs", patch: patch('[Route("api/reports")]') },
		]);
		expect(candidates.map((candidate) => candidate.source)).toEqual([
			"route-declaration",
			"file-route",
		]);
	});

	it("à preuve égale, la route la plus courte passe devant", () => {
		const candidates = deriveLandingCandidates([
			{ path: "src/Api/Controllers/AController.cs", patch: patch('[Route("api/a/deep/deeper")]') },
			{ path: "src/Api/Controllers/BController.cs", patch: patch('[Route("api/b")]') },
		]);
		expect(candidates[0].path).toBe("/api/b");
	});

	it("propose le profil de lancement puis la doc d'API quand le diff ne dit rien", () => {
		expect(
			deriveLandingCandidates([], { framework: "dotnet", launchPath: "swagger/index.html" }),
		).toEqual([
			{ path: "/swagger/index.html", source: "launch-profile" },
			{ path: "/swagger", source: "api-docs" },
		]);
		expect(deriveLandingPath([], { framework: "fastapi" })?.path).toBe("/docs");
		expect(deriveLandingPath([], { framework: "vite" })).toBeNull();
	});

	it("ne rend rien quand il n'y a ni diff ni framework connu", () => {
		expect(deriveLandingPath([])).toBeNull();
	});
});

describe("normalizeLandingPath / buildLandingUrl", () => {
	it.each([
		["swagger", "/swagger"],
		["/swagger/", "/swagger"],
		["/", "/"],
		["  ", null],
		[undefined, null],
	])("%s → %s", (input, expected) => {
		expect(normalizeLandingPath(input)).toBe(expected);
	});

	it("colle le chemin sur l'origine du serveur", () => {
		expect(buildLandingUrl("http://localhost:5000", "/api/documents")).toBe(
			"http://localhost:5000/api/documents",
		);
		expect(buildLandingUrl("http://localhost:5000/", "swagger")).toBe(
			"http://localhost:5000/swagger",
		);
	});

	it("rend l'URL de base telle quelle pour la racine", () => {
		expect(buildLandingUrl("http://localhost:5000", "/")).toBe("http://localhost:5000");
		expect(buildLandingUrl("http://localhost:5000", null)).toBe("http://localhost:5000");
	});
});

describe("resolveAddressInput", () => {
	const base = "http://localhost:5000/api/documents";

	it("résout une entrée relative contre le serveur", () => {
		expect(resolveAddressInput("/swagger", base)).toBe("http://localhost:5000/swagger");
		expect(resolveAddressInput("swagger", base)).toBe("http://localhost:5000/api/swagger");
	});

	it("garde une URL absolue", () => {
		expect(resolveAddressInput("https://example.com/x", base)).toBe("https://example.com/x");
	});

	it("reconnaît un hôte avec un port", () => {
		expect(resolveAddressInput("localhost:5001/health", base)).toBe(
			"http://localhost:5001/health",
		);
		expect(resolveAddressInput("example.com", base)).toBe("http://example.com/");
	});

	it("refuse un schéma qui n'est pas http(s)", () => {
		expect(resolveAddressInput("javascript:alert(1)", base)).toBeNull();
		expect(resolveAddressInput("file:///etc/passwd", base)).toBeNull();
		expect(resolveAddressInput("   ", base)).toBeNull();
	});
});
