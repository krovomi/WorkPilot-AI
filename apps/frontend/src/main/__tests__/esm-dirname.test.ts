import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN_DIR = path.resolve(import.meta.dirname, "..");

function typescriptFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			files.push(...typescriptFiles(fullPath));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(fullPath);
		}
	}
	return files;
}

describe("Electron main ESM paths", () => {
	it("derives __dirname from import.meta.url before using it", () => {
		const offenders = typescriptFiles(MAIN_DIR)
			.filter((file) => {
				const source = readFileSync(file, "utf-8");
				return (
					source.includes("__dirname") &&
					!source.includes("fileURLToPath(import.meta.url)")
				);
			})
			.map((file) => path.relative(MAIN_DIR, file));

		expect(offenders).toEqual([]);
	});
});
