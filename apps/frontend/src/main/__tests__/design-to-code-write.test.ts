/**
 * Import Design writes into the project only what the person accepted, each
 * path resolved inside it; and it reads the project's stack from its
 * manifests, whatever the language.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { projects } = vi.hoisted(() => ({
	projects: new Map<string, { id: string; path: string }>(),
}));

vi.mock("electron", () => ({
	app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
}));
vi.mock("../project-store", () => ({
	projectStore: {
		getProject: (id: string) => projects.get(id),
		getProjects: () => [...projects.values()],
	},
}));
vi.mock("../python-env-manager", () => ({ pythonEnvManager: {} }));
vi.mock("../updater/path-resolver", () => ({ getEffectiveSourcePath: () => tmpdir() }));
vi.mock("../utils/python-runner-env", () => ({ pythonRunnerEnv: () => ({}) }));

import { detectProjectStack } from "../design-to-code-stack";
import { DesignToCodeService, projectDirFor } from "../design-to-code-service";

let root: string;
let project: string;
let outside: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "dtc-write-")));
	project = path.join(root, "project");
	outside = path.join(root, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	projects.clear();
	projects.set("p1", { id: "p1", path: project });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("writeFiles", () => {
	it("writes new files and replaces existing ones, inside the project", () => {
		mkdirSync(path.join(project, "src"));
		writeFileSync(path.join(project, "src", "Header.tsx"), "old");
		const outcome = new DesignToCodeService().writeFiles("p1", [
			{ path: "src/Header.tsx", content: "new header" },
			{ path: "src/components/pricing/Hero.tsx", content: "hero" },
		]);
		expect(outcome.refused).toEqual([]);
		expect(outcome.written).toEqual([
			{ path: "src/Header.tsx", created: false },
			{ path: "src/components/pricing/Hero.tsx", created: true },
		]);
		expect(readFileSync(path.join(project, "src", "Header.tsx"), "utf-8")).toBe("new header");
		expect(existsSync(path.join(project, "src", "components", "pricing", "Hero.tsx"))).toBe(true);
	});

	it("replaces a longer file entirely, with nothing of the old one left", () => {
		writeFileSync(path.join(project, "Button.tsx"), "x".repeat(500));
		const outcome = new DesignToCodeService().writeFiles("p1", [
			{ path: "Button.tsx", content: "short" },
		]);
		expect(outcome.written).toEqual([{ path: "Button.tsx", created: false }]);
		expect(readFileSync(path.join(project, "Button.tsx"), "utf-8")).toBe("short");
	});

	it("refuses paths that leave the project, even through a link", () => {
		symlinkSync(outside, path.join(project, "linked"), "dir");
		const outcome = new DesignToCodeService().writeFiles("p1", [
			{ path: "../outside/escape.txt", content: "x" },
			{ path: path.join(outside, "absolute.txt"), content: "x" },
			{ path: "linked/through-link.txt", content: "x" },
		]);
		expect(outcome.written).toEqual([]);
		expect(outcome.refused.map((r) => r.reason)).toEqual(["outside", "outside", "outside"]);
		expect(existsSync(path.join(outside, "escape.txt"))).toBe(false);
		expect(existsSync(path.join(outside, "absolute.txt"))).toBe(false);
		expect(existsSync(path.join(outside, "through-link.txt"))).toBe(false);
	});

	it("refuses the files an agent must not touch", () => {
		const outcome = new DesignToCodeService().writeFiles("p1", [
			{ path: ".git/hooks/pre-commit", content: "x" },
			{ path: "packages/app/.git/config", content: "x" },
			{ path: ".workpilot/specs/x.md", content: "x" },
			{ path: ".claude/settings.json", content: "x" },
			{ path: ".env.local", content: "x" },
			{ path: ".github/workflows/ci.yml", content: "x" },
		]);
		expect(outcome.written).toEqual([]);
		expect(outcome.refused.every((r) => r.reason === "protected")).toBe(true);
		expect(existsSync(path.join(project, ".env.local"))).toBe(false);
	});

	it("refuses malformed entries and a folder in place of a file", () => {
		mkdirSync(path.join(project, "src", "Card.tsx"), { recursive: true });
		const outcome = new DesignToCodeService().writeFiles("p1", [
			{ path: "", content: "x" },
			{ path: "a.ts", content: 42 },
			{ path: "big.ts", content: "x".repeat(1024 * 1024 + 1) },
			{ path: "src/Card.tsx", content: "x" },
		]);
		expect(outcome.written).toEqual([]);
		expect(outcome.refused.map((r) => r.reason)).toEqual([
			"invalid",
			"invalid",
			"invalid",
			"invalid",
		]);
	});

	it("names a project by id only", () => {
		const service = new DesignToCodeService();
		expect(() => service.writeFiles(project, [])).toThrow("Unknown project");
		expect(() => service.writeFiles("p1", "not a list")).toThrow("Invalid file list");
		expect(projectDirFor("p1")).toBe(project);
		expect(projectDirFor(undefined)).toBeNull();
	});
});

describe("detectProjectStack", () => {
	const write = (relative: string, content: string) => {
		const file = path.join(project, relative);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	};

	it("reads a Next.js project and its CSS framework", () => {
		write(
			"package.json",
			JSON.stringify({ dependencies: { next: "15", react: "19" }, devDependencies: { tailwindcss: "4" } }),
		);
		mkdirSync(path.join(project, "src", "styles"), { recursive: true });
		expect(detectProjectStack(project)).toEqual({
			stack: "nextjs",
			style: "tailwind",
			evidence: ["package.json"],
			designSystemPath: "src/styles",
		});
	});

	it("finds an Angular front end in a sub-folder", () => {
		write("frontend/package.json", JSON.stringify({ dependencies: { "@angular/core": "20" } }));
		const detection = detectProjectStack(project);
		expect(detection.stack).toBe("angular");
		expect(detection.evidence).toEqual([path.join("frontend", "package.json")]);
	});

	it.each([
		["App/App.csproj", '<Project><PropertyGroup><UseMaui>true</UseMaui></PropertyGroup></Project>', "maui"],
		["Desk/Desk.csproj", '<Project><ItemGroup><PackageReference Include="Avalonia" /></ItemGroup></Project>', "avalonia"],
		["Win/Win.csproj", "<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>", "wpf"],
		["Web/Web.csproj", '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"></Project>', "blazor"],
		["pubspec.yaml", "name: app\nflutter:\n  uses-material-design: true\n", "flutter"],
		["app/build.gradle.kts", "android { buildFeatures { compose = true } }", "jetpack_compose"],
		["Package.swift", "// swift-tools-version:5.9", "swiftui"],
		["index.html", "<!doctype html>", "html"],
	])("recognises %s", (file, content, stack) => {
		write(file, content);
		expect(detectProjectStack(project).stack).toBe(stack);
	});

	it("says nothing about a project it cannot read", () => {
		write("main.go", "package main");
		expect(detectProjectStack(project).stack).toBeNull();
	});

	it("does not read a file larger than a manifest", () => {
		write("package.json", JSON.stringify({ dependencies: { next: "15" }, pad: "x".repeat(600 * 1024) }));
		expect(detectProjectStack(project).stack).toBeNull();
	});

	it("does not look inside dependencies", () => {
		write("node_modules/react/package.json", JSON.stringify({ dependencies: { react: "19" } }));
		expect(detectProjectStack(project).stack).toBeNull();
	});
});
