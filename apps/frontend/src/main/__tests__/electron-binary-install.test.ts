// @vitest-environment node
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Electron 44 dropped its own postinstall: the package ships `install-electron`
// and leaves the binary download to whoever installs it. Without that step
// node_modules/electron has no path.txt and `electron-vite dev` stops with
// "Electron uninstall". Our postinstall runs it; this test fails if it stops
// doing so while the pinned Electron still does not download on its own.
const frontendRoot = join(__dirname, "..", "..", "..");

it("the pinned Electron binary is downloaded at install time", () => {
	const { scripts } = JSON.parse(
		readFileSync(join(frontendRoot, "package.json"), "utf8"),
	);
	const electronPkg = JSON.parse(
		readFileSync(
			join(
				realpathSync(join(frontendRoot, "node_modules", "electron")),
				"package.json",
			),
			"utf8",
		),
	);

	const downloadsItself = Boolean(
		electronPkg.scripts?.postinstall || electronPkg.scripts?.install,
	);
	if (downloadsItself) return;

	expect(electronPkg.bin?.["install-electron"]).toBeTruthy();
	expect(scripts.postinstall).toMatch(/^install-electron && /);
});
