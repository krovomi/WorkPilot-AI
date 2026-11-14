/**
 * The renderer is a sandboxed page (`sandbox: true`, no Node integration): a
 * Node built-in such as `node:fs` or `path` does not exist there. Vite only
 * warns ("Module "node:fs" has been externalized for browser compatibility")
 * and the call fails at run time, so this test refuses the import instead.
 * Disk, paths and processes go through `window.electronAPI` and the main.
 */

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER = path.resolve(__dirname, "..");
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
// `import … from "x"`, `export … from "x"`, `import("x")`, `require("x")`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" || entry.name === "__mocks__" ? [] : sourceFiles(full);
		}
		if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec|stories)\.tsx?$|\.d\.ts$/.test(entry.name)) {
			return [];
		}
		return [full];
	});
}

function nodeBuiltinImports(source: string): string[] {
	return [...source.matchAll(SPECIFIER)]
		.map((match) => match[1])
		.filter((specifier) => {
			const bare = specifier.replace(/^node:/, "");
			return specifier.startsWith("node:") || BUILTINS.has(bare) || BUILTINS.has(bare.split("/")[0]);
		});
}

describe("renderer sources", () => {
	it("never import a Node built-in", () => {
		const offenders = sourceFiles(RENDERER).flatMap((file) =>
			nodeBuiltinImports(readFileSync(file, "utf8")).map(
				(specifier) => `${path.relative(RENDERER, file)}: ${specifier}`,
			),
		);
		expect(offenders).toEqual([]);
	});

	it("the scan sees each import form", () => {
		expect(
			nodeBuiltinImports(
				[
					'import fs from "node:fs";',
					"import path from 'path';",
					'export { join } from "node:path";',
					'const os = await import("os");',
					'const cp = require("child_process");',
					'import "node:process";',
					'import { x } from "./fs";',
					'import { y } from "@/lib/path";',
					'import z from "react";',
				].join("\n"),
			),
		).toEqual(["node:fs", "path", "node:path", "os", "child_process", "node:process"]);
	});
});
