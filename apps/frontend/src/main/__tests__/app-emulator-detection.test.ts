/**
 * App Emulator project detection, on real folders: which framework, which
 * command, which port, and which folder runs it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEmulatorService } from "../app-emulator-service";
import {
	addFiles,
	cleanWorld,
	pkg,
	project,
	realPause,
	resetWorld,
	spawnsOf,
	world,
} from "./app-emulator-world";

vi.mock("node:child_process", async () =>
	(await import("./app-emulator-world")).childProcessModule(),
);
vi.mock("../platform", async () => (await import("./app-emulator-world")).platformModule());

const detect = (dir: string) => new AppEmulatorService().detectProject(dir);

const SDK_WEB = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>';
const SDK_LIB = '<Project Sdk="Microsoft.NET.Sdk"></Project>';
const LEGACY = [
	"<Project>",
	"  <PropertyGroup>",
	"    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>",
	"    <AssemblyName>Heavy.Client</AssemblyName>",
	"  </PropertyGroup>",
	"</Project>",
].join("\n");

function launchSettings(applicationUrl: string, launchUrl?: string): string {
	return JSON.stringify({
		profiles: { app: { applicationUrl, ...(launchUrl ? { launchUrl } : {}) } },
	});
}

beforeEach(() => {
	resetWorld();
});

afterEach(async () => {
	await cleanWorld();
});

describe("detectProject — input folder", () => {
	it("refuses a folder that does not exist", async () => {
		await expect(detect("/nowhere/at/all")).rejects.toThrow(
			"Project directory not found: /nowhere/at/all",
		);
	});

	it("decodes a URI-encoded folder and announces the configuration", async () => {
		const dir = project({ "go.mod": "module x" }, "my app");
		const service = new AppEmulatorService();
		const announced = vi.fn();
		service.on("config", announced);

		const config = await service.detectProject(dir.replace("my app", "my%20app"));

		expect(config).toMatchObject({ framework: "go", projectDir: dir });
		expect(announced).toHaveBeenCalledWith(config);
		expect(service.getConfig()).toBe(config);
	});
});

describe("detectProject — Node.js", () => {
	it.each([
		[{ next: "1" }, "next", 3000, "web"],
		[{ nuxt: "1" }, "nuxt", 3000, "web"],
		[{ nuxt3: "1" }, "nuxt", 3000, "web"],
		[{ "react-scripts": "1" }, "create-react-app", 3000, "web"],
		[{ vite: "1" }, "vite", 5173, "web"],
		[{ vue: "1" }, "vue-cli", 8080, "web"],
		[{ svelte: "1" }, "svelte", 5173, "web"],
		[{ "@sveltejs/kit": "1" }, "svelte", 5173, "web"],
		[{ electron: "1" }, "electron", 0, "desktop"],
		[{ "@nestjs/core": "1" }, "nestjs", 3000, "web"],
		[{ fastify: "1" }, "express", 3000, "web"],
		[{ "@hapi/hapi": "1" }, "express", 3000, "web"],
		[{ lodash: "1" }, "node", 3000, "web"],
	])("reads %o as %s on port %i", async (deps, framework, port, type) => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: deps }),
		});

		const config = await detect(dir);

		expect(config).toMatchObject({
			framework,
			port,
			type,
			isWeb: type === "web",
			startCommand: "npm run dev",
			projectDir: dir,
		});
	});

	it("serves Angular with an explicit port, whatever its scripts say", async () => {
		const dir = project({
			"package.json": pkg({ scripts: { start: "ng serve" }, dependencies: { "@angular/core": "1" } }),
		});

		expect(await detect(dir)).toMatchObject({
			framework: "angular",
			port: 4200,
			startCommand: "npx ng serve --port 4200",
		});
	});

	it.each([
		[{ "start:dev": "x", start: "y" }, "npm run start:dev"],
		[{ serve: "x", start: "y" }, "npm run serve"],
		[{ start: "x" }, "npm start"],
		[{ build: "x", lint: "y" }, "npm run build"],
		[{}, ""],
	])("picks the start script from %o", async (scripts, startCommand) => {
		const dir = project({ "package.json": pkg({ scripts }) });

		expect((await detect(dir)).startCommand).toBe(startCommand);
	});

	it.each([
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["bun.lockb", "bun"],
		["bun.lock", "bun"],
	])("runs the package manager whose lockfile %s is there", async (lockfile, pm) => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" } }),
			[lockfile]: "",
		});

		expect((await detect(dir)).startCommand).toBe(`${pm} run dev`);
	});

	it("skips an unreadable package.json and tries the next kind of project", async () => {
		const dir = project({ "package.json": "{ not json", "Cargo.toml": "[package]" });

		expect(await detect(dir)).toMatchObject({
			framework: "rust",
			type: "cli",
			startCommand: "cargo run",
			isWeb: false,
		});
	});
});

describe("detectProject — fullstack layouts", () => {
	it("pairs a Vite front with the Express API in its server folder", async () => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "1" } }),
			"server/package.json": pkg({
				scripts: { start: "node ." },
				dependencies: { express: "1" },
			}),
		});

		const config = await detect(dir);

		expect(config).toMatchObject({
			framework: "express",
			startCommand: "npm start",
			port: 3000,
			projectDir: path.join(dir, "server"),
		});
		expect(config.services).toEqual([
			{
				label: "Backend (express)",
				framework: "express",
				startCommand: "npm start",
				port: 3000,
				projectDir: path.join(dir, "server"),
				isPrimary: true,
			},
			{
				label: "Frontend (vite)",
				framework: "vite",
				startCommand: "npm run dev",
				port: 5173,
				projectDir: dir,
				isPrimary: false,
			},
		]);
	});

	it.each([
		[{ dev: "x" }, "npm run dev"],
		[{ "start:dev": "x" }, "npm run start:dev"],
		[{}, "npm start"],
	])("starts a Node API found beside a front with %o", async (scripts, startCommand) => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: { vite: "1" } }),
			"api/package.json": pkg({ scripts, dependencies: { koa: "1" } }),
		});

		expect((await detect(dir)).services?.[0]).toMatchObject({ startCommand });
	});

	it.each([
		[{ "start:dev": "x" }, "npm run start:dev"],
		[{}, "npm run dev"],
	])("starts a NestJS API found beside a front with %o", async (scripts, startCommand) => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: { svelte: "1" } }),
			"backend/package.json": pkg({ scripts, dependencies: { "@nestjs/core": "1" } }),
		});

		expect((await detect(dir)).services?.[0]).toMatchObject({
			framework: "nestjs",
			startCommand,
		});
	});

	it("does not take a second front for the backend, and looks one level deeper", async () => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: { vite: "1" } }),
			"admin/package.json": pkg({ dependencies: { "@angular/core": "1" } }),
			"admin/broken/package.json": "{",
			"public/main.py": "",
			".git/HEAD": "",
			"packages/core/go.mod": "module core",
		});

		const config = await detect(dir);

		expect(config.services?.[0]).toMatchObject({
			framework: "go",
			projectDir: path.join(dir, "packages", "core"),
		});
	});

	it.each([
		[{ "manage.py": "" }, "django", "python manage.py runserver", 8000],
		[{ "requirements.txt": "FastAPI\n", "app.py": "" }, "fastapi", "uvicorn app:app --reload --port 8000", 8000],
		[{ "pyproject.toml": "fastapi" }, "fastapi", "uvicorn main:app --reload --port 8000", 8000],
		[{ "requirements.txt": "flask", "app.py": "" }, "flask", "python app.py", 5000],
		[{ "requirements.txt": "flask" }, "flask", "python main.py", 5000],
		[{ "main.py": "" }, "python", "python main.py", 8000],
		[{ "app.py": "" }, "python", "python app.py", 8000],
		[{ "Cargo.toml": "" }, "rust", "cargo run", 8080],
	])("finds the %o backend of a front", async (files, framework, startCommand, port) => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: { vite: "1" } }),
		});
		addFiles(path.join(dir, "backend"), files);

		expect((await detect(dir)).services?.[0]).toMatchObject({
			framework,
			startCommand,
			port,
			projectDir: path.join(dir, "backend"),
		});
	});

	it("runs a .NET API that sits directly in the backend folder", async () => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: { vite: "1" } }),
			"backend/Api.csproj": SDK_WEB,
			"backend/.vs/": "",
			"backend/bin/": "",
		});

		expect((await detect(dir)).services?.[0]).toMatchObject({
			framework: "dotnet",
			projectDir: path.join(dir, "backend"),
		});
	});

	it("leaves a Streamlit app alone when looking for a backend", async () => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: { vite: "1" } }),
			"dashboard/requirements.txt": "streamlit",
			"dashboard/app.py": "",
		});

		const config = await detect(dir);

		expect(config.services).toBeUndefined();
		expect(config.framework).toBe("vite");
	});

	it("pairs a front with the .NET API one folder below the backend folder", async () => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "x" }, devDependencies: { vite: "1" } }),
			"backend/.vs/": "",
			"backend/README.md": "",
			"backend/Api/Api.csproj": SDK_WEB,
			"backend/Api/Properties/launchSettings.json": launchSettings("http://localhost:5080"),
		});

		expect((await detect(dir)).services?.[0]).toMatchObject({
			framework: "dotnet",
			startCommand: "dotnet run",
			port: 5080,
			projectDir: path.join(dir, "backend", "Api"),
		});
	});

	it("pairs an Express root with the front in a client folder", async () => {
		const dir = project({
			"package.json": pkg({ scripts: { dev: "node ." }, dependencies: { express: "1" } }),
			"client/package.json": pkg({
				scripts: { serve: "vue-cli-service serve" },
				dependencies: { vue: "1" },
			}),
		});

		const config = await detect(dir);

		expect(config.services?.map((svc) => [svc.framework, svc.projectDir])).toEqual([
			["express", dir],
			["vue-cli", path.join(dir, "client")],
		]);
	});

	it.each([
		[{ "manage.py": "" }, "django"],
		[{ "requirements.txt": "fastapi" }, "fastapi"],
		[{ "go.mod": "module x" }, "go"],
	])("pairs a %o root with its front", async (files, framework) => {
		const dir = project({
			...files,
			"web/package.json": pkg({ scripts: { start: "x" }, dependencies: { next: "1" } }),
		});

		const config = await detect(dir);

		expect(config.services?.map((svc) => svc.framework)).toEqual([framework, "next"]);
		expect(config.services?.[1].startCommand).toBe("npm start");
	});
});

describe("detectProject — fronts found in subfolders", () => {
	it.each([
		[{ "@angular/core": "1" }, "angular", 4200, "npx ng serve --port 4200"],
		[{ next: "1" }, "next", 3000, "npm run dev"],
		[{ nuxt: "1" }, "nuxt", 3000, "npm run dev"],
		[{ "react-scripts": "1" }, "create-react-app", 3000, "npm run dev"],
		[{ vite: "1" }, "vite", 5173, "npm run dev"],
		[{ vue: "1" }, "vue-cli", 8080, "npm run dev"],
		[{ "@sveltejs/kit": "1" }, "svelte", 5173, "npm run dev"],
		[{ electron: "1" }, "electron", 0, "npm run dev"],
		[{ lodash: "1" }, "node", 3000, "npm run dev"],
	])("reads the %o front of a bare folder", async (deps, framework, port, startCommand) => {
		const dir = project({
			"package.json": "{ unreadable",
			"apps/ui/package.json": pkg({ scripts: { dev: "x" }, dependencies: deps }),
		});

		expect(await detect(dir)).toMatchObject({
			framework,
			port,
			startCommand,
			isWeb: framework !== "electron",
			projectDir: path.join(dir, "apps", "ui"),
		});
	});

	it.each([
		[{ "start:dev": "x" }, "yarn run start:dev"],
		[{ serve: "x" }, "yarn run serve"],
		[{ start: "x" }, "yarn start"],
		[{ test: "x" }, "yarn run test"],
	])("starts a nested front from %o", async (scripts, startCommand) => {
		const dir = project({
			"package.json": "{ unreadable",
			"ui/package.json": pkg({ scripts }),
			"ui/yarn.lock": "",
		});

		expect(await detect(dir)).toMatchObject({ framework: "node", startCommand });
	});

	it("passes over hidden, build and script-less folders", async () => {
		const dir = project({
			"package.json": "{ unreadable",
			".cache/package.json": pkg({ scripts: { dev: "x" } }),
			"dist/package.json": pkg({ scripts: { dev: "x" } }),
			"lockonly/package.json": pkg({ dependencies: { vite: "1" } }),
			"empty/a/b/c/": "",
			"real/package.json": pkg({ scripts: { dev: "x" }, devDependencies: { vite: "1" } }),
		});

		expect((await detect(dir)).projectDir).toBe(path.join(dir, "real"));
	});
});

describe("detectProject — Python, Go, Rust, Docker", () => {
	it.each([
		[{ "manage.py": "" }, "django", "python manage.py runserver", 8000, true],
		[{ "pyproject.toml": "django>=5" }, "django", "python manage.py runserver", 8000, true],
		[{ "requirements.txt": "fastapi", "app.py": "" }, "fastapi", "uvicorn app:app --reload --port 8000", 8000, true],
		[{ "requirements.txt": "fastapi" }, "fastapi", "uvicorn main:app --reload --port 8000", 8000, true],
		[{ "requirements.txt": "Flask", "app.py": "" }, "flask", "python app.py", 5000, true],
		[{ "pyproject.toml": "flask" }, "flask", "python main.py", 5000, true],
		[{ "requirements.txt": "streamlit", "app.py": "" }, "streamlit", "streamlit run app.py", 8501, true],
		[{ "requirements.txt": "streamlit" }, "streamlit", "streamlit run main.py", 8501, true],
		[{ "main.py": "" }, "python", "python main.py", 0, false],
		[{ "app.py": "" }, "python", "python app.py", 0, false],
	])("reads %o", async (files, framework, startCommand, port, isWeb) => {
		const dir = project(files);

		expect(await detect(dir)).toMatchObject({
			framework,
			startCommand,
			port,
			isWeb,
			type: isWeb ? "web" : "cli",
		});
	});

	it("runs a Go module on 8080", async () => {
		expect(await detect(project({ "go.mod": "module x" }))).toMatchObject({
			type: "web",
			framework: "go",
			startCommand: "go run .",
			port: 8080,
			isWeb: true,
		});
	});

	it.each(["docker-compose.yml", "docker-compose.yaml"])(
		"publishes the first port of %s",
		async (file) => {
			const dir = project({ [file]: 'services:\n  web:\n    ports:\n      - "8088:80"\n' });

			expect(await detect(dir)).toMatchObject({
				framework: "docker-compose",
				startCommand: "docker-compose up",
				port: 8088,
			});
		},
	);

	it("reads only the ports block of a compose file, and survives an unreadable one", async () => {
		const scoped = project({
			"docker-compose.yml": [
				"services:",
				"  web:",
				"    ports:",
				"      - $WEB_PORT",
				"      - '7070:80'",
				"    volumes:",
				"      - '9999:/data'",
			].join("\n"),
		});
		const late = project({
			"docker-compose.yml": "services:\n  web:\n    ports:\n      - x\n    image: y\n    environment:\n      - '6060'\n",
		});
		const unreadable = project({ "docker-compose.yml/": "" });

		expect((await detect(scoped)).port).toBe(7070);
		expect((await detect(late)).port).toBe(3000);
		expect((await detect(unreadable)).port).toBe(3000);
	});

	it("builds and runs a Dockerfile on its exposed port", async () => {
		const dir = project({ Dockerfile: "FROM node\nEXPOSE 9090\n" });

		expect(await detect(dir)).toMatchObject({
			framework: "docker",
			startCommand: "docker build -t app . && docker run -p 9090:9090 app",
			port: 9090,
		});
	});
});

describe("detectProject — .NET", () => {
	it("runs a web project from its launch settings", async () => {
		const dir = project({
			"Api.csproj": SDK_WEB,
			"Properties/launchSettings.json": launchSettings(
				"https://localhost:7001;http://localhost:5123",
				"swagger",
			),
		});

		expect(await detect(dir)).toMatchObject({
			type: "web",
			framework: "dotnet",
			startCommand: "dotnet run",
			port: 5123,
			projectDir: dir,
			launchPath: "/swagger",
		});
	});

	it("takes the launch path from the first profile that names a page", async () => {
		const dir = project({
			"Api.csproj": SDK_WEB,
			"Properties/launchSettings.json": JSON.stringify({
				profiles: {
					root: { launchUrl: "http://localhost:5000/" },
					broken: { launchUrl: "http://[nope" },
					blank: { launchUrl: "  " },
					page: { launchUrl: "https://localhost:5001/health?probe=1" },
				},
			}),
		});
		const unreadable = project({ "Api.csproj": SDK_WEB, "Properties/launchSettings.json/": "" });

		expect((await detect(dir)).launchPath).toBe("/health?probe=1");
		expect(await detect(unreadable)).toMatchObject({ port: 5000, launchPath: undefined });
	});

	it("falls back to the https port, then to 5000", async () => {
		const https = project({
			"Api.csproj": SDK_WEB,
			"Properties/launchSettings.json": JSON.stringify({
				profiles: { iis: {}, app: { applicationUrl: "https://localhost:7443" } },
			}),
		});
		const none = project({
			"Api.csproj": SDK_WEB,
			"Properties/launchSettings.json": "{ broken",
		});
		const noProfiles = project({
			"Api.csproj": SDK_WEB,
			"Properties/launchSettings.json": "{}",
		});

		expect((await detect(https)).port).toBe(7443);
		expect(await detect(none)).toMatchObject({ port: 5000, launchPath: undefined });
		expect((await detect(noProfiles)).port).toBe(5000);
	});

	it("starts the first runnable project of a solution, skipping tests and libraries", async () => {
		const dir = project({
			"App.sln": [
				'Project("{FAE}") = "Tests", "Tests\\App.Tests\\App.Tests.csproj", "{1}"',
				'Project("{FAE}") = "Core", "Core\\Core.csproj", "{2}"',
				'Project("{FAE}") = "Gone", "Gone\\Gone.csproj", "{3}"',
				'Project("{FAE}") = "Web", "Web\\Web.csproj", "{4}"',
			].join("\n"),
			"App.Tests.sln": 'Project("{FAE}") = "T", "T\\T.csproj", "{9}"',
			"Aaa.sln/": "",
			"Tests/App.Tests/App.Tests.csproj": SDK_WEB,
			"Core/Core.csproj": SDK_LIB,
			"Web/Web.csproj": "<Project><OutputType>Exe</OutputType></Project>",
		});
		// A .sln names its projects with "\"; on POSIX that is part of the name.
		addFiles(dir, { "Web\\Web.csproj": "<Project><OutputType>Exe</OutputType></Project>" });

		const config = await detect(dir);

		expect(config.framework).toBe("dotnet");
		expect(config.projectDir).toBe(path.dirname(path.resolve(dir, "Web\\Web.csproj")));
	});

	it("prefers the folder with an entry point, then an executable, then a library", async () => {
		const withProgram = project({
			"App.sln": "",
			"src/Lib/Lib.csproj": SDK_LIB,
			"src/Svc/Svc.csproj": SDK_LIB,
			"src/Svc/Program.cs": "",
		});
		const withExe = project({
			"App.sln": "",
			"src/A/A.csproj": SDK_LIB,
			"src/B/B.csproj": '<Project Sdk="Microsoft.NET.Sdk.Worker"></Project>',
		});
		const onlyLibraries = project({
			"App.sln": "",
			"src/A/A.csproj": SDK_LIB,
			"src/B/B.csproj": '<Project Sdk="Microsoft.NET.Sdk.Razor"></Project>',
		});

		expect((await detect(withProgram)).projectDir).toBe(path.join(withProgram, "src", "Svc"));
		expect((await detect(withExe)).projectDir).toBe(path.join(withExe, "src", "B"));
		expect((await detect(onlyLibraries)).projectDir).toBe(path.join(onlyLibraries, "src", "A"));
	});

	it("treats an unreadable project file as runnable, and looks no deeper than five levels", async () => {
		const odd = project({ "App.sln": "", "src/Odd.csproj/": "" });
		const deep = project({
			"App.sln": "",
			"a/b/c/d/e/f/Deep.csproj": SDK_WEB,
		});

		expect((await detect(odd)).projectDir).toBe(path.join(odd, "src"));
		expect((await detect(deep)).projectDir).toBe(deep);
	});

	it("runs a solution whose only project is a library, from that project", async () => {
		const dir = project({
			"App.sln": "",
			"Lib.csproj": "<Project><OutputType>Library</OutputType></Project>",
		});

		expect((await detect(dir)).projectDir).toBe(dir);
	});

	it("stays at the root of a solution without any project", async () => {
		const dir = project({ "Empty.sln": "" });

		expect(await detect(dir)).toMatchObject({ framework: "dotnet", projectDir: dir });
	});

	it("pairs a .NET API with the front beside it", async () => {
		const dir = project({
			"Api.csproj": SDK_WEB,
			"ClientApp/package.json": pkg({
				scripts: { start: "ng serve" },
				dependencies: { "@angular/core": "1" },
			}),
		});

		const config = await detect(dir);

		expect(config.services).toEqual([
			expect.objectContaining({ framework: "dotnet", port: 5000, projectDir: dir }),
			expect.objectContaining({
				framework: "angular",
				port: 4200,
				startCommand: "npx ng serve --port 4200",
				projectDir: path.join(dir, "ClientApp"),
			}),
		]);
	});

	it("serves a legacy web project through IIS Express or xsp on Unix", async () => {
		const dir = project({
			"Site.csproj": LEGACY,
			"Global.asax": "",
			"Properties/launchSettings.json": launchSettings("http://localhost:8123", "home"),
		});

		const config = await detect(dir);

		expect(config).toMatchObject({
			framework: "dotnet-framework-iis-express",
			port: 8123,
			isWeb: true,
			launchPath: "/home",
		});
		expect(config.startCommand.startsWith("sh -lc ")).toBe(true);
		expect(config.startCommand).toContain("xsp4");
		expect(config.startCommand).toContain(`--root '\\''${dir}'\\''`);
		expect(config.startCommand).toContain("--port 8123");
	});

	it.each([
		["<Project><TargetFramework>net48</TargetFramework></Project>", "Web.config"],
		[
			'<Project><TargetFrameworkVersion>v4.0</TargetFrameworkVersion><Import Project="Microsoft.WebApplication.targets" /></Project>',
			"",
		],
		[
			"<Project><TargetFrameworkVersion>v4.5</TargetFrameworkVersion><ProjectTypeGuids>{349C5851-65DF-11DA-9384-00065B846F21}</ProjectTypeGuids></Project>",
			"",
		],
	])("recognises a legacy web project from %s", async (csproj, marker) => {
		const dir = project({ "Site.csproj": csproj, ...(marker ? { [marker]: "" } : {}) });

		expect(await detect(dir)).toMatchObject({
			framework: "dotnet-framework-iis-express",
			port: 8080,
		});
	});

	it("serves a legacy web project through PowerShell on Windows", async () => {
		world.windows = true;
		vi.stubEnv("WORKPILOT_IIS_EXPRESS_PATH", "D:\\iis\\iisexpress.exe");
		vi.stubEnv("PROGRAMFILES(X86)", "C:\\PF86");
		vi.stubEnv("ProgramFiles", "C:\\PF");
		const dir = project({ "Site.csproj": LEGACY, "Web.config": "" });

		const { startCommand } = await detect(dir);

		expect(startCommand.startsWith("powershell -NoProfile -ExecutionPolicy Bypass -Command")).toBe(
			true,
		);
		expect(startCommand).toContain("'D:\\iis\\iisexpress.exe'");
		expect(startCommand).toContain(path.join("C:\\PF86", "IIS Express", "iisexpress.exe"));
		expect(startCommand).toContain(path.join("C:\\PF", "IIS Express", "iisexpress.exe"));
		expect(startCommand).toContain(`/path:'${dir}' /port:8080`);
		vi.unstubAllEnvs();
	});

	it("lists no known IIS Express path on Windows when none is configured", async () => {
		world.windows = true;
		vi.stubEnv("WORKPILOT_IIS_EXPRESS_PATH", "");
		vi.stubEnv("PROGRAMFILES(X86)", "");
		vi.stubEnv("ProgramFiles", "");
		const dir = project({ "Site.csproj": LEGACY, "Web.config": "" });

		expect((await detect(dir)).startCommand).toContain("$known=@()");
		vi.unstubAllEnvs();
	});

	it("builds and runs a legacy desktop app with msbuild and mono on Unix", async () => {
		const dir = project({ "Heavy.csproj": LEGACY, "Program.cs": "" });

		const config = await detect(dir);

		expect(config).toMatchObject({
			type: "desktop",
			framework: "dotnet-framework-desktop",
			isWeb: false,
			port: 0,
			projectDir: dir,
		});
		expect(config.startCommand).toContain("WORKPILOT_MSBUILD_PATH");
		expect(config.startCommand).toContain("Heavy.Client.exe");
		expect(config.startCommand).toContain("mono");
		expect(config.startCommand).toContain(`/p:SolutionDir=${dir}${path.sep}`);
	});

	it("builds a legacy desktop app from the solution that declares it", async () => {
		const dir = project({
			"Suite.sln": 'Project("{FAE}") = "Heavy", "src\\Heavy\\Heavy.csproj", "{1}"',
			"Other.sln": 'Project("{FAE}") = "Else", "else\\Else.csproj", "{2}"',
			"src/Heavy/Heavy.csproj": LEGACY.replace(
				"<AssemblyName>Heavy.Client</AssemblyName>",
				"",
			),
		});

		const config = await detect(path.join(dir));

		expect(config.framework).toBe("dotnet-framework-desktop");
		expect(config.startCommand).toContain(`/p:SolutionDir=${dir}${path.sep}`);
		expect(config.startCommand).toContain("Heavy.exe");
	});

	it("writes the legacy desktop build script on Windows", async () => {
		world.windows = true;
		const dir = project({ "Heavy.csproj": LEGACY });

		const config = await detect(dir);

		const scriptPath = path.join(dir, "obj", "workpilot-run-legacy-desktop.ps1");
		expect(config.startCommand).toBe(
			`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
		);
		const script = readFileSync(scriptPath, "utf-8");
		expect(script).toContain(`$projectPath = '${path.join(dir, "Heavy.csproj")}'`);
		expect(script).toContain("$assemblyFilter = 'Heavy.Client.exe'");
	});
});

describe("detectProject — WorkPilot workspace stubs", () => {
	it("runs the project found inside a nested folder, preferring src", async () => {
		const dir = project({
			"docs/README.md": "",
			"tools/go.mod": "module tools",
			"src/go.mod": "module app",
			"tests/go.mod": "module tests",
			"node_modules/x/package.json": pkg({ scripts: { dev: "x" } }),
		});

		expect((await detect(dir)).projectDir).toBe(path.join(dir, "src"));
	});

	it("prefers a solution folder over a lone project folder at the same depth", async () => {
		const dir = project({
			"a/A.csproj": SDK_WEB,
			"b/B.sln": "",
			"b/B.csproj": SDK_WEB,
		});

		expect((await detect(dir)).projectDir).toBe(path.join(dir, "b"));
	});

	it("uses the parent of a stub when the parent is the project", async () => {
		const parent = project({ "go.mod": "module app" }, "repo");
		const stub = path.join(parent, "workspace");
		addFiles(stub, { ".workpilot/": "" });

		expect((await detect(stub)).projectDir).toBe(parent);
	});

	it("uses a sibling of a stub, Sources first", async () => {
		const parent = project({}, "repo");
		addFiles(parent, {
			"workspace/.workpilot/": "",
			"Alpha/go.mod": "module alpha",
			"Sources/manage.py": "",
			".hidden/go.mod": "",
			"node_modules/go.mod": "",
			"notes.txt": "",
		});

		expect((await detect(path.join(parent, "workspace"))).framework).toBe("django");
	});

	it("passes over hidden, vendored and plain-file siblings of a stub", async () => {
		const parent = project({}, "repo");
		addFiles(parent, {
			"workspace/.workpilot/": "",
			".hidden/go.mod": "",
			"node_modules/go.mod": "",
			"notes.txt": "",
			"zeta/manage.py": "",
		});

		expect((await detect(path.join(parent, "workspace"))).projectDir).toBe(
			path.join(parent, "zeta"),
		);
	});

	it("does not look more than five levels down for a project", async () => {
		const dir = project({ "a/b/c/d/e/f/go.mod": "module deep", "x/y/go.mod": "module y" });

		expect((await detect(dir)).projectDir).toBe(path.join(dir, "x", "y"));
	});

	it("keeps the stub when no sibling is a project", async () => {
		const parent = project({}, "repo");
		addFiles(parent, { "workspace/.workpilot/": "", "empty/": "" });
		world.onSpawn = (call) => setImmediate(() => call.proc.exit(1));
		const stub = path.join(parent, "workspace");

		await expect(detect(stub)).rejects.toThrow("Detection failed (exit code 1)");
		expect(world.spawns[0].args.slice(1)).toEqual(["--project-dir", stub]);
	});
});

describe("detectProject — the Python runner fallback", () => {
	function runnerDir(): string {
		return project({ "runners/app_emulator_runner.py": "" }, "backend");
	}

	function answer(stdout: string, code = 0, stderr = "") {
		world.onSpawn = (call) => {
			setImmediate(() => {
				if (stdout) call.proc.print(stdout);
				if (stderr) call.proc.print(stderr, "stderr");
				call.proc.exit(code);
			});
		};
	}

	it("asks the runner of the configured backend, without credentials", async () => {
		const backend = runnerDir();
		const dir = project({ "notes.txt": "" });
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-0000");
		answer(
			'log line\n__APP_EMULATOR_RESULT__:{"success":true,"type":"web","framework":"phoenix","startCommand":"mix phx.server","port":4000,"isWeb":true}',
		);
		const service = new AppEmulatorService();
		service.configure("/usr/bin/python3", backend);

		const config = await service.detectProject(dir);

		expect(config).toEqual({
			type: "web",
			framework: "phoenix",
			startCommand: "mix phx.server",
			port: 4000,
			isWeb: true,
			projectDir: dir,
		});
		const [call] = spawnsOf("/usr/bin/python3");
		expect(call.args).toEqual([
			path.join(backend, "runners", "app_emulator_runner.py"),
			"--project-dir",
			dir,
		]);
		expect(call.options.cwd).toBe(backend);
		expect(call.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(call.options.env?.PYTHONUTF8).toBe("1");
		vi.unstubAllEnvs();
	});

	it("finds the backend of this checkout when none is configured", async () => {
		const dir = project({ "notes.txt": "" });
		answer('__APP_EMULATOR_RESULT__:{"success":true,"type":"cli","framework":"x","startCommand":"x","port":0,"isWeb":false}');
		const service = new AppEmulatorService();
		service.configure(undefined, "/not/a/backend");

		await service.detectProject(dir);

		const [call] = spawnsOf("python");
		expect(existsSync(call.args[0])).toBe(true);
		expect(call.args[0].endsWith(path.join("runners", "app_emulator_runner.py"))).toBe(true);
	});

	it("reports the runner's own error, or a generic one", async () => {
		const service = new AppEmulatorService();
		service.configure(undefined, runnerDir());
		const dir = project({ "notes.txt": "" });

		answer('__APP_EMULATOR_RESULT__:{"success":false,"error":"Nothing runnable"}');
		await expect(service.detectProject(dir)).rejects.toThrow("Nothing runnable");

		answer('__APP_EMULATOR_RESULT__:{"success":false}');
		await expect(service.detectProject(dir)).rejects.toThrow(
			`Could not detect project type in: ${dir}`,
		);
	});

	it("reports an unreadable result and a run without result", async () => {
		const service = new AppEmulatorService();
		service.configure(undefined, runnerDir());
		const dir = project({ "notes.txt": "" });

		answer("__APP_EMULATOR_RESULT__:{oops");
		await expect(service.detectProject(dir)).rejects.toThrow(
			"Failed to parse detection result",
		);

		answer("", 2, "Traceback: boom");
		await expect(service.detectProject(dir)).rejects.toThrow(
			"Detection failed (exit code 2): Traceback: boom",
		);
	});

	it("reports a runner that cannot start", async () => {
		const service = new AppEmulatorService();
		service.configure(undefined, runnerDir());
		world.onSpawn = (call) => setImmediate(() => call.proc.fail("spawn python ENOENT"));

		await expect(service.detectProject(project({ "notes.txt": "" }))).rejects.toThrow(
			"Failed to start detection: spawn python ENOENT",
		);
	});

	it("cancels a detection still running, also when a new one starts", async () => {
		const service = new AppEmulatorService();
		service.configure(undefined, runnerDir());
		const dir = project({ "notes.txt": "" });
		const first = service.detectProject(dir);
		first.catch(() => undefined);
		await realPause(5);
		const [running] = world.spawns;

		answer('__APP_EMULATOR_RESULT__:{"success":true,"type":"cli","framework":"x","startCommand":"x","port":0,"isWeb":false}');
		await service.detectProject(dir);
		expect(running.proc.killed).toBe(true);

		world.onSpawn = (call) => {
			call.proc.exitOnKill = false;
		};
		const third = service.detectProject(dir);
		third.catch(() => undefined);
		await realPause(5);
		const fourth = service.detectProject(dir);
		fourth.catch(() => undefined);
		await realPause(5);
		const fifth = service.detectProject(dir);
		fifth.catch(() => undefined);
		await realPause(5);
		// The replaced runners exit or fail late; the running one is still the one cancelled.
		world.spawns[2].proc.exit(null);
		world.spawns[3].proc.fail("late failure");
		service.cancelDetection();
		expect(world.spawns[4].proc.killed).toBe(true);
		service.cancelDetection();
	});
});
