import path from "node:path";
import { readFile, walkFiles } from "./source-files";

/**
 * .NET project awareness for the source scan.
 *
 * A user points the API Explorer at the folder holding the `.sln`, not at the
 * one folder holding `Program.cs`. Walking every `.cs` file underneath already
 * finds the API — but it also finds the integration-test project's fake
 * controllers, and reports their routes as endpoints of the application.
 *
 * So the scan reads the `.csproj` files first, and answers two questions per
 * file: which project owns it, and is that project a test project.
 */

export type DotnetProjectKind = "web" | "test" | "library";

export interface DotnetProject {
	/** The assembly name: `Rag.Api` for `src/Rag.Api/Rag.Api.csproj`. */
	name: string;
	/** Absolute path of the directory holding the project file. */
	dir: string;
	/** Absolute path of the project file itself. */
	file: string;
	kind: DotnetProjectKind;
	/** The evidence that decided `kind`, so a surprise is explainable. */
	reason: string;
}

/**
 * Test runners and hosts. Every one of these is unambiguous: none appears in
 * an application that ships. Assertion and mocking libraries are deliberately
 * absent — a production project may reference them for its own test helpers.
 */
const TEST_PACKAGES =
	/PackageReference\s+Include\s*=\s*"(xunit(?:\.[\w.]+)?|NUnit(?:\.[\w.]+)?|NUnit3TestAdapter|MSTest(?:\.[\w.]+)?|Microsoft\.NET\.Test\.Sdk|Machine\.Specifications(?:\.[\w.]+)?|Microsoft\.AspNetCore\.Mvc\.Testing)"/i;

/** `Rag.Api.Tests`, `Rag.Specs`, `Rag-Benchmarks`. */
const TEST_NAME = /(?:^|[.\-_])(tests?|specs?|benchmarks?|e2e)$/i;

/** Directory names that hold test projects by convention. */
const TEST_DIRS = new Set(["test", "tests", "spec", "specs"]);

/** The web SDK, or the shared framework a controller library references. */
const WEB_SDK = /Sdk\s*=\s*"[^"]*Microsoft\.NET\.Sdk\.Web[^"]*"/i;
const WEB_FRAMEWORK_REFERENCE =
	/FrameworkReference\s+Include\s*=\s*"Microsoft\.AspNetCore\.App"/i;
const WEB_PACKAGES =
	/PackageReference\s+Include\s*=\s*"(Microsoft\.AspNetCore\.[\w.]+|Swashbuckle\.AspNetCore(?:\.[\w.]+)?|NSwag\.AspNetCore|FastEndpoints(?:\.[\w.]+)?|Carter)"/i;

/**
 * The naming convention the user asked for — `*.API` and its neighbours.
 * It is the weakest signal here, and it is only ever read to *promote* a
 * project to `web`, never to demote one.
 */
const WEB_NAME =
	/(?:^|[.\-_])(api|webapi|web|http|rest|server|host|gateway|endpoints?|presentation)$/i;

function classify(name: string, relativeDir: string, xml: string) {
	const segments = relativeDir
		.split(/[\\/]/)
		.filter(Boolean)
		.map((segment) => segment.toLowerCase());

	if (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(xml)) {
		return { kind: "test" as const, reason: "IsTestProject" };
	}
	const testPackage = xml.match(TEST_PACKAGES);
	if (testPackage) {
		return { kind: "test" as const, reason: `references ${testPackage[1]}` };
	}
	if (TEST_NAME.test(name)) {
		return { kind: "test" as const, reason: "project name" };
	}
	const testDir = segments.find((segment) => TEST_DIRS.has(segment));
	if (testDir) {
		return { kind: "test" as const, reason: `under ${testDir}/` };
	}

	if (WEB_SDK.test(xml)) {
		return { kind: "web" as const, reason: "Microsoft.NET.Sdk.Web" };
	}
	if (WEB_FRAMEWORK_REFERENCE.test(xml)) {
		return { kind: "web" as const, reason: "Microsoft.AspNetCore.App" };
	}
	const webPackage = xml.match(WEB_PACKAGES);
	if (webPackage) {
		return { kind: "web" as const, reason: `references ${webPackage[1]}` };
	}
	if (WEB_NAME.test(name)) {
		return { kind: "web" as const, reason: "project name" };
	}

	return { kind: "library" as const, reason: "no web reference" };
}

/** Every `.csproj` under `projectPath`, classified. */
export function findDotnetProjects(projectPath: string): DotnetProject[] {
	const projects: DotnetProject[] = [];
	for (const file of walkFiles(projectPath, [".csproj"])) {
		const name = path.basename(file, ".csproj");
		const dir = path.dirname(file);
		// An unreadable project file is not an absent one: it still owns its
		// directory, and classifying it as a library keeps its sources in.
		const xml = readFile(file) ?? "";
		const { kind, reason } = classify(
			name,
			path.relative(projectPath, dir),
			xml,
		);
		projects.push({ name, dir, file, kind, reason });
	}
	return projects;
}

/** The project owning `file`: the nearest ancestor directory holding one. */
export function ownerOf(
	file: string,
	projects: DotnetProject[],
): DotnetProject | undefined {
	const byDir = new Map<string, DotnetProject>();
	for (const project of projects) {
		if (!byDir.has(project.dir)) byDir.set(project.dir, project);
	}
	return ownerFrom(file, byDir);
}

function ownerFrom(
	file: string,
	byDir: Map<string, DotnetProject>,
): DotnetProject | undefined {
	let dir = path.dirname(file);
	for (;;) {
		const owner = byDir.get(dir);
		if (owner) return owner;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export interface DotnetSourceSelection {
	/** The `.cs` files worth scanning, in walk order. */
	files: string[];
	/** The owning project of each kept file, by absolute file path. */
	owners: Map<string, DotnetProject>;
	projects: DotnetProject[];
	/** How many files a test project claimed. */
	excluded: number;
	/**
	 * True when every file belonged to a test project and the exclusion was
	 * undone. A repository of nothing but tests is odd, but reporting zero
	 * endpoints there would be a worse answer than reporting the routes found.
	 */
	relaxed: boolean;
}

/**
 * Splits the `.cs` files of a solution into what the application serves and
 * what only its test projects declare.
 *
 * Library projects are kept: in a clean architecture the controllers often
 * live in `Foo.Presentation`, a plain `Microsoft.NET.Sdk` library the API host
 * references. Excluding anything that is not the web project itself would lose
 * exactly the endpoints this exists to find.
 */
export function selectDotnetSources(
	projectPath: string,
	files: string[],
): DotnetSourceSelection {
	const projects = findDotnetProjects(projectPath);
	const byDir = new Map<string, DotnetProject>();
	for (const project of projects) {
		if (!byDir.has(project.dir)) byDir.set(project.dir, project);
	}

	const owners = new Map<string, DotnetProject>();
	const kept: string[] = [];
	let excluded = 0;

	for (const file of files) {
		const owner = ownerFrom(file, byDir);
		if (owner) owners.set(file, owner);
		if (owner?.kind === "test") {
			excluded += 1;
			continue;
		}
		kept.push(file);
	}

	if (kept.length === 0 && files.length > 0) {
		return {
			files,
			owners,
			projects,
			excluded: 0,
			relaxed: true,
		};
	}

	return { files: kept, owners, projects, excluded, relaxed: false };
}
