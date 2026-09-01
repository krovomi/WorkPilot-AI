import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("preserves a source-scanned spec when a manual URL fails", () => {
	const source = readFileSync(
		path.join(import.meta.dirname, "ApiExplorer.tsx"),
		"utf-8",
	);

	expect(source).toContain(
		'if (useApiExplorerStore.getState().specSource !== "scan")',
	);
});
