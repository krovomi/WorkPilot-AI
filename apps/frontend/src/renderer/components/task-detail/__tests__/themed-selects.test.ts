/**
 * A native `<select>` opens a list drawn by the OS, which ignores the app's
 * colour theme (a white list in every dark theme). The task panel uses the
 * app's `Select` (`ui/select.tsx`) for every list a person opens.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TASK_DETAIL = path.resolve(import.meta.dirname, "..");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(full);
		return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [full] : [];
	});
}

describe("task panel lists follow the theme", () => {
	it("opens no native <select>", () => {
		const offenders = sources(TASK_DETAIL)
			.filter((file) =>
				readFileSync(file, "utf8")
					.split("\n")
					// A comment may name the element; only markup counts.
					.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
					.some((line) => /<(select|NativeSelect)\b/.test(line)),
			)
			.map((file) => path.relative(TASK_DETAIL, file));
		expect(offenders).toEqual([]);
	});
});
