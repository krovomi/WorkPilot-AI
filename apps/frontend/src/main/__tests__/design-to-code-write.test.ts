/**
 * Import Design writes only what the person accepted, each path resolved
 * inside the project and then inside the review card's worktree, never in
 * the project folder itself; and it reads the project's stack from its
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
vi.mock("../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../generated-review/review-card", () => ({ findOpenReviewCard: () => null }));
vi.mock("../generated-review/review-run", () => ({
	findLocalProject: () => undefined,
	openReviewRun: () => Promise.reject(new Error("no review run in this test")),
}));

import { detectProjectStack } from "../design-to-code-stack";
import { DesignToCodeService, projectDirFor } from "../design-to-code-service";

let root: string;
let project: string;
let worktree: string;
let outside: string;
let run: {
	root: string;
	map: (target: string | undefined) => string | undefined;
	finish: ReturnType<typeof vi.fn>;
	abandon: ReturnType<typeof vi.fn>;
};
let openRun: ReturnType<typeof vi.fn>;
const review = {
	taskId: "001-design",
	specId: "001-design",
	title: "Design importé : Header",
	branch: "workpilot/001-design",
	baseBranch: "develop",
	files: ["src/Header.tsx"],
	committed: true,
	reused: false,
};
/** Write the files with the review run of this test. */
const writeFiles = (service: DesignToCodeService, id: unknown, files: unknown) =>
	service.writeFiles(id, files, openRun as never);

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "dtc-write-")));
	project = path.join(root, "project");
	worktree = path.join(project, ".workpilot", "worktrees", "tasks", "001-design");
	outside = path.join(root, "outside");
	mkdirSync(project);
	mkdirSync(worktree, { recursive: true });
	mkdirSync(outside);
	run = {
		root: worktree,
		map: (target) => target,
		finish: vi.fn(async () => review),
		abandon: vi.fn(async () => undefined),
	};
	openRun = vi.fn(async () => run);
	projects.clear();
	projects.set("p1", { id: "p1", path: project });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("writeFiles", () => {
	it("writes on the review card's branch, never in the project folder", async () => {
		mkdirSync(path.join(worktree, "src"));
		writeFileSync(path.join(worktree, "src", "Header.tsx"), "old");
		const outcome = await writeFiles(new DesignToCodeService(), "p1", [
			{ path: "src/Header.tsx", content: "new header" },
			{ path: "src/components/pricing/Hero.tsx", content: "hero" },
		]);
		expect(outcome.refused).toEqual([]);
		expect(outcome.written).toEqual([
			{ path: "src/Header.tsx", created: false },
			{ path: "src/components/pricing/Hero.tsx", created: true },
		]);
		expect(outcome.review).toEqual(review);
		expect(openRun).toHaveBeenCalledWith(project, "design-import", "Header");
		expect(run.finish).toHaveBeenCalledWith({
			message: "feat: add Header from an imported design",
			summary: "Composant importé d'un design : Header",
		});
		expect(readFileSync(path.join(worktree, "src", "Header.tsx"), "utf-8")).toBe("new header");
		expect(existsSync(path.join(worktree, "src", "components", "pricing", "Hero.tsx"))).toBe(true);
		expect(existsSync(path.join(project, "src"))).toBe(false);
	});

	it("replaces a longer file entirely, with nothing of the old one left", async () => {
		writeFileSync(path.join(worktree, "Button.tsx"), "x".repeat(500));
		const outcome = await writeFiles(new DesignToCodeService(), "p1", [
			{ path: "Button.tsx", content: "short" },
		]);
		expect(outcome.written).toEqual([{ path: "Button.tsx", created: false }]);
		expect(readFileSync(path.join(worktree, "Button.tsx"), "utf-8")).toBe("short");
	});

	it("refuses paths that leave the project, even through a link, and opens no card", async () => {
		symlinkSync(outside, path.join(project, "linked"), "dir");
		const outcome = await writeFiles(new DesignToCodeService(), "p1", [
			{ path: "../outside/escape.txt", content: "x" },
			{ path: path.join(outside, "absolute.txt"), content: "x" },
			{ path: "linked/through-link.txt", content: "x" },
		]);
		expect(outcome.written).toEqual([]);
		expect(outcome.refused.map((r) => r.reason)).toEqual(["outside", "outside", "outside"]);
		expect(openRun).not.toHaveBeenCalled();
		expect(existsSync(path.join(outside, "escape.txt"))).toBe(false);
		expect(existsSync(path.join(outside, "absolute.txt"))).toBe(false);
		expect(existsSync(path.join(outside, "through-link.txt"))).toBe(false);
	});

	it("refuses a link of the worktree that leaves it, and takes the card back", async () => {
		symlinkSync(outside, path.join(worktree, "linked"), "dir");
		const outcome = await writeFiles(new DesignToCodeService(), "p1", [
			{ path: "linked/through-link.txt", content: "x" },
		]);
		expect(outcome.refused).toEqual([{ path: "linked/through-link.txt", reason: "outside" }]);
		expect(existsSync(path.join(outside, "through-link.txt"))).toBe(false);
		expect(run.abandon).toHaveBeenCalled();
		expect(run.finish).not.toHaveBeenCalled();
	});

	it("refuses the files an agent must not touch", async () => {
		const outcome = await writeFiles(new DesignToCodeService(), "p1", [
			{ path: ".git/hooks/pre-commit", content: "x" },
			{ path: "packages/app/.git/config", content: "x" },
			{ path: ".workpilot/specs/x.md", content: "x" },
			{ path: ".claude/settings.json", content: "x" },
			{ path: ".env.local", content: "x" },
			{ path: ".github/workflows/ci.yml", content: "x" },
		]);
		expect(outcome.written).toEqual([]);
		expect(outcome.refused.every((r) => r.reason === "protected")).toBe(true);
		expect(existsSync(path.join(worktree, ".env.local"))).toBe(false);
		expect(openRun).not.toHaveBeenCalled();
	});

	it("refuses malformed entries and a folder in place of a file", async () => {
		mkdirSync(path.join(worktree, "src", "Card.tsx"), { recursive: true });
		const outcome = await writeFiles(new DesignToCodeService(), "p1", [
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

	it("takes the card back when the commit fails, and says so", async () => {
		run.finish.mockRejectedValueOnce(new Error("git has no author identity"));
		await expect(
			writeFiles(new DesignToCodeService(), "p1", [{ path: "Hero.tsx", content: "x" }]),
		).rejects.toThrow("git has no author identity");
		expect(run.abandon).toHaveBeenCalled();
	});

	it("writes nothing when the review branch cannot be prepared", async () => {
		openRun.mockRejectedValueOnce(new Error("not a git repository"));
		await expect(
			writeFiles(new DesignToCodeService(), "p1", [{ path: "Hero.tsx", content: "x" }]),
		).rejects.toThrow("not a git repository");
		expect(existsSync(path.join(project, "Hero.tsx"))).toBe(false);
	});

	it("names a project by id only", async () => {
		const service = new DesignToCodeService();
		await expect(writeFiles(service, project, [])).rejects.toThrow("Unknown project");
		await expect(writeFiles(service, "p1", "not a list")).rejects.toThrow("Invalid file list");
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
