#!/usr/bin/env node
/**
 * Simple packaging script that uses electron-builder directly without Python runtime.
 * This script packages the Electron app with the backend included.
 */

const { spawnSync } = require("node:child_process");

/**
 * The electron-builder arguments for the arguments this script received.
 *
 * `pnpm run package:linux -- --publish never` hands this script a literal
 * `--` before `--publish never`. Passed on as is, electron-builder's parser
 * stops at that `--` and never reads `--publish never`: on a tag it then
 * publishes by itself with the job's read-only token, which is how the tag
 * runs of 1.4.0 and 1.4.1 stopped on a 403 on all four platforms (F184). A
 * bare `--` means nothing to electron-builder here, so it is dropped.
 */
function electronBuilderArgs(argv) {
	const args = argv.filter((arg) => arg !== "--");

	// Default platforms if none specified
	if (args.length === 0) {
		args.push("--win", "--mac", "--linux");
	}

	// Remove duplicate arguments and clean up
	const cleanArgs = [];
	const seen = new Set();

	for (const arg of args) {
		if (!seen.has(arg)) {
			seen.add(arg);
			cleanArgs.push(arg);
		}
	}

	// Ensure we use 'mac' instead of 'mas' for standard distribution
	return cleanArgs.map((arg) => (arg === "--mas" ? "--mac" : arg));
}

function main() {
	const finalArgs = electronBuilderArgs(process.argv.slice(2));

	// Run electron-builder with the provided arguments
	const result = spawnSync("electron-builder", finalArgs, {
		stdio: "inherit",
		shell: true,
		cwd: process.cwd(),
	});

	if (result.status !== 0) {
		console.error("❌ Packaging failed");
		process.exit(result.status || 1);
	}
}

if (require.main === module) {
	main();
}

module.exports = { electronBuilderArgs };
