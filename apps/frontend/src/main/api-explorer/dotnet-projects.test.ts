import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findDotnetProjects,
	ownerOf,
	selectDotnetSources,
} from "./dotnet-projects";
import { walkFiles } from "./source-files";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createSolution(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "workpilot-sln-"));
	roots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return root;
}

const WEB_SDK = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>';
const LIBRARY_SDK = '<Project Sdk="Microsoft.NET.Sdk"></Project>';

function select(root: string) {
	return selectDotnetSources(root, walkFiles(root, [".cs"]));
}

function relative(root: string, files: string[]): string[] {
	return files.map((file) => path.relative(root, file).replace(/\\/g, "/"));
}

describe("findDotnetProjects", () => {
	it("reads the web SDK rather than the project name", () => {
		const root = createSolution({
			"src/Rag.Ingestion/Rag.Ingestion.csproj": WEB_SDK,
			"src/Rag.Ingestion/Program.cs": "",
		});

		const [project] = findDotnetProjects(root);

		expect(project.name).toBe("Rag.Ingestion");
		expect(project.kind).toBe("web");
		expect(project.reason).toBe("Microsoft.NET.Sdk.Web");
	});

	it("promotes a *.Api project the SDK line does not mark", () => {
		const root = createSolution({
			"src/Rag.API/Rag.API.csproj": LIBRARY_SDK,
			"src/Rag.API/Program.cs": "",
		});

		expect(findDotnetProjects(root)[0]).toMatchObject({
			kind: "web",
			reason: "project name",
		});
	});

	it("reads a controller library as web through its framework reference", () => {
		const root = createSolution({
			"src/Rag.Presentation/Rag.Presentation.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>
</Project>`,
		});

		expect(findDotnetProjects(root)[0]).toMatchObject({
			kind: "web",
			reason: "Microsoft.AspNetCore.App",
		});
	});

	it.each([
		[
			"IsTestProject",
			"Rag.Verification",
			`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>`,
			"IsTestProject",
		],
		[
			"a runner package reference",
			"Rag.Verification",
			`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit.v3" Version="1.0.0" /></ItemGroup></Project>`,
			"references xunit.v3",
		],
		["the project name", "Rag.Api.Tests", LIBRARY_SDK, "project name"],
	])("classifies a test project by %s", (_label, name, xml, reason) => {
		const root = createSolution({ [`src/${name}/${name}.csproj`]: xml });

		expect(findDotnetProjects(root)[0]).toMatchObject({ kind: "test", reason });
	});

	it("classifies by the tests/ folder a solution puts them in", () => {
		const root = createSolution({
			"tests/Verification/Verification.csproj": LIBRARY_SDK,
		});

		expect(findDotnetProjects(root)[0]).toMatchObject({
			kind: "test",
			reason: "under tests/",
		});
	});

	it("reads a test host as a test project, not as a web one", () => {
		const root = createSolution({
			"tests/Rag.Api.Tests/Rag.Api.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />
  </ItemGroup>
</Project>`,
		});

		expect(findDotnetProjects(root)[0].kind).toBe("test");
	});
});

describe("selectDotnetSources", () => {
	it("keeps the application and drops what only the tests declare", () => {
		const root = createSolution({
			"Rag.sln": "Microsoft Visual Studio Solution File, Format Version 12.00",
			"src/Rag.Api/Rag.Api.csproj": WEB_SDK,
			"src/Rag.Api/Program.cs": "",
			"src/Rag.Api/Controllers/DocumentsController.cs": "",
			"src/Rag.Domain/Rag.Domain.csproj": LIBRARY_SDK,
			"src/Rag.Domain/Document.cs": "",
			"tests/Rag.Api.Tests/Rag.Api.Tests.csproj": LIBRARY_SDK,
			"tests/Rag.Api.Tests/FakeController.cs": "",
		});

		const selection = select(root);

		expect(relative(root, selection.files).sort()).toEqual([
			"src/Rag.Api/Controllers/DocumentsController.cs",
			"src/Rag.Api/Program.cs",
			"src/Rag.Domain/Document.cs",
		]);
		expect(selection.excluded).toBe(1);
		expect(selection.relaxed).toBe(false);
	});

	it("names the owner of every file it keeps", () => {
		const root = createSolution({
			"src/Rag.Api/Rag.Api.csproj": WEB_SDK,
			"src/Rag.Api/Controllers/DocumentsController.cs": "",
		});

		const selection = select(root);
		const owner = selection.owners.get(selection.files[0]);

		expect(owner?.name).toBe("Rag.Api");
	});

	it("attributes a file to the nearest project, not the outermost", () => {
		const root = createSolution({
			"Host/Host.csproj": WEB_SDK,
			"Host/Modules/Rag.Admin/Rag.Admin.csproj": WEB_SDK,
			"Host/Modules/Rag.Admin/AdminController.cs": "",
		});
		const nested = path.join(
			root,
			"Host/Modules/Rag.Admin/AdminController.cs",
		);

		expect(ownerOf(nested, findDotnetProjects(root))?.name).toBe("Rag.Admin");
	});

	it("keeps every file when no project file explains the tree", () => {
		const root = createSolution({ "Controllers/DocumentsController.cs": "" });

		const selection = select(root);

		expect(selection.files).toHaveLength(1);
		expect(selection.owners.size).toBe(0);
	});

	it("scans a solution of nothing but tests rather than reporting none", () => {
		const root = createSolution({
			"tests/Rag.Api.Tests/Rag.Api.Tests.csproj": LIBRARY_SDK,
			"tests/Rag.Api.Tests/FakeController.cs": "",
		});

		const selection = select(root);

		expect(selection.files).toHaveLength(1);
		expect(selection.relaxed).toBe(true);
		expect(selection.excluded).toBe(0);
	});
});
