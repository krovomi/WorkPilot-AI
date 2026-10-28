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

// The main process is bundled as ESM by electron-vite, whose CommonJS shim
// injects `const __filename`, `const __dirname` and `const require` at the
// top of any chunk that mentions them. A module-level binding of one of those
// names in our code can then keep its bare name in the bundle, and the main
// process fails to load with "Identifier '__filename' has already been
// declared". Main-process code therefore reads its location from
// import.meta.dirname / import.meta.filename and never declares these names.
describe("Electron main ESM paths", () => {
	it("uses import.meta.dirname / import.meta.filename instead of __dirname / __filename", () => {
		const offenders = typescriptFiles(MAIN_DIR)
			.filter((file) =>
				/\b__(dirname|filename)\b/.test(readFileSync(file, "utf-8")),
			)
			.map((file) => path.relative(MAIN_DIR, file));

		expect(offenders).toEqual([]);
	});

	it("never declares a module-level require", () => {
		const offenders = typescriptFiles(MAIN_DIR)
			.filter((file) =>
				/^(?:export\s+)?(?:const|let|var)\s+require\b/m.test(
					readFileSync(file, "utf-8"),
				),
			)
			.map((file) => path.relative(MAIN_DIR, file));

		expect(offenders).toEqual([]);
	});
});
