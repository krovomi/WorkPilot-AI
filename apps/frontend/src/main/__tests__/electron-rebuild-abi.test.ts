// @vitest-environment node
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// The postinstall runs electron-rebuild, which asks node-abi for the ABI of the
// pinned Electron and aborts when its registry does not list that major. CI
// installs with CI set, so the rebuild never runs there: this test is what
// fails on an Electron bump that outruns node-abi (pnpm-workspace.yaml floor).
const frontendRoot = join(__dirname, "..", "..", "..");

it("the node-abi used by electron-rebuild knows the pinned Electron", async () => {
	const { devDependencies } = JSON.parse(
		readFileSync(join(frontendRoot, "package.json"), "utf8"),
	);
	const electronVersion: string = devDependencies.electron;
	expect(electronVersion).toMatch(/^\d+\.\d+\.\d+$/);

	const rebuildDir = realpathSync(
		join(frontendRoot, "node_modules", "@electron", "rebuild"),
	);
	const nodeAbiEntry = createRequire(join(rebuildDir, "package.json")).resolve(
		"node-abi",
	);
	const { getAbi } = await import(pathToFileURL(nodeAbiEntry).href);

	expect(getAbi(electronVersion, "electron")).toMatch(/^\d+$/);
});
