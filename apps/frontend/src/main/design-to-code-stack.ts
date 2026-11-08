import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import path from "node:path";
import type {
	DesignStack,
	DesignStackDetection,
	DesignStyle,
} from "../shared/types/design-to-code";

/**
 * Which stack a project is written in, so Import Design generates code the
 * project can use without a second guess. Read from the manifests at the
 * project root (and one level below, for a solution or a monorepo app):
 * nothing is executed, and a file larger than a manifest is not read.
 */

const MAX_MANIFEST_BYTES = 512 * 1024;
const SKIPPED_DIRS = new Set([
	"node_modules",
	".git",
	"bin",
	"obj",
	"dist",
	"build",
	".next",
	".nuxt",
	"Pods",
	"vendor",
]);

/**
 * The manifest's text, or null when it is missing or larger than a manifest.
 * One open descriptor, no stat-then-read: the size is what was actually read.
 */
function readSmall(file: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const read = readSync(fd, buffer, total, buffer.length - total, null);
			if (read === 0) break;
			total += read;
		}
		if (total > MAX_MANIFEST_BYTES) return null;
		return buffer.toString("utf-8", 0, total);
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** The project root and its direct sub-folders (a solution, a monorepo). */
function candidateDirs(root: string): string[] {
	const dirs = [root];
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
				dirs.push(path.join(root, entry.name));
			}
		}
	} catch {
		/* unreadable root: only the root itself */
	}
	return dirs;
}

function listFiles(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

interface Hit {
	stack: DesignStack;
	style: DesignStyle | null;
	file: string;
}

function fromPackageJson(dir: string, root: string): Hit | null {
	const file = path.join(dir, "package.json");
	const text = readSmall(file);
	if (!text) return null;
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		pkg = JSON.parse(text);
	} catch {
		return null;
	}
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const has = (name: string) => Object.hasOwn(deps, name);
	let stack: DesignStack | null = null;
	if (has("react-native") || has("expo")) stack = "react_native";
	else if (has("next")) stack = "nextjs";
	else if (has("nuxt")) stack = "nuxt";
	else if (has("@angular/core")) stack = "angular";
	else if (has("svelte")) stack = "svelte";
	else if (has("vue")) stack = "vue";
	else if (has("react")) stack = "react";
	if (!stack) return null;

	let style: DesignStyle | null = null;
	if (stack !== "react_native") {
		if (has("tailwindcss")) style = "tailwind";
		else if (has("styled-components")) style = "styled_components";
		else if (has("sass")) style = "scss";
	}
	return { stack, style, file: path.relative(root, file) };
}

function fromDotnet(dir: string, root: string): Hit | null {
	for (const name of listFiles(dir)) {
		if (!name.endsWith(".csproj")) continue;
		const text = readSmall(path.join(dir, name)) ?? "";
		const file = path.relative(root, path.join(dir, name));
		if (/<UseMaui>\s*true/i.test(text)) return { stack: "maui", style: null, file };
		if (/Avalonia/.test(text)) return { stack: "avalonia", style: null, file };
		if (/<UseWPF>\s*true|Microsoft\.WindowsAppSDK|<UseWinUI>\s*true/i.test(text))
			return { stack: "wpf", style: null, file };
		if (/Microsoft\.AspNetCore\.Components|Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"/.test(text))
			return { stack: "blazor", style: null, file };
		if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(text) && existsSync(path.join(dir, "Components")))
			return { stack: "blazor", style: null, file };
	}
	return null;
}

function fromNative(dir: string, root: string): Hit | null {
	const files = listFiles(dir);
	const rel = (name: string) => path.relative(root, path.join(dir, name));
	if (files.includes("pubspec.yaml")) {
		const text = readSmall(path.join(dir, "pubspec.yaml")) ?? "";
		if (/^\s*flutter:/m.test(text)) return { stack: "flutter", style: null, file: rel("pubspec.yaml") };
	}
	for (const gradle of ["build.gradle.kts", "build.gradle"]) {
		if (!files.includes(gradle)) continue;
		const text = readSmall(path.join(dir, gradle)) ?? "";
		if (/compose/i.test(text)) return { stack: "jetpack_compose", style: null, file: rel(gradle) };
	}
	if (files.includes("Package.swift")) {
		return { stack: "swiftui", style: null, file: rel("Package.swift") };
	}
	try {
		const xcode = readdirSync(dir).find((n) => n.endsWith(".xcodeproj"));
		if (xcode) return { stack: "swiftui", style: null, file: rel(xcode) };
	} catch {
		/* not a directory listing */
	}
	return null;
}

/** Where the design tokens live, when the project has a usual folder for them. */
function findDesignSystem(root: string): string | null {
	const candidates = [
		"src/design-system",
		"src/styles",
		"src/theme",
		"styles",
		"theme",
		"design-system",
		"lib/theme",
		"Resources/Styles",
		"wwwroot/css",
	];
	for (const candidate of candidates) {
		const full = path.join(root, candidate);
		try {
			if (statSync(full).isDirectory()) return candidate;
		} catch {
			/* absent */
		}
	}
	return null;
}

export function detectProjectStack(projectRoot: string): DesignStackDetection {
	const hits: Hit[] = [];
	for (const dir of candidateDirs(projectRoot)) {
		const hit = fromPackageJson(dir, projectRoot) ?? fromDotnet(dir, projectRoot) ?? fromNative(dir, projectRoot);
		if (hit) hits.push(hit);
	}
	// The root wins over a sub-folder; among sub-folders, the first found.
	const best = hits[0];
	if (!best) {
		const html = listFiles(projectRoot).includes("index.html");
		return {
			stack: html ? "html" : null,
			style: null,
			evidence: html ? ["index.html"] : [],
			designSystemPath: findDesignSystem(projectRoot),
		};
	}
	return {
		stack: best.stack,
		style: best.style,
		evidence: [best.file],
		designSystemPath: findDesignSystem(projectRoot),
	};
}
