#!/usr/bin/env node
/**
 * Start the app once and require it to say it mounted (src/main/smoke-test.ts).
 *
 *   node scripts/smoke-test.cjs            the built app (`out/`, after `pnpm run build`)
 *   node scripts/smoke-test.cjs --packaged the unpacked app electron-builder left in `dist/`
 *
 * Exit 0 only when the app prints WORKPILOT_SMOKE_OK and exits 0 within the
 * timeout. A main process that dies while loading (1.3.1, F114), a renderer
 * that never mounts, or an app that hangs all fail. On Linux, run it under
 * `xvfb-run -a` when there is no display.
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OK_MARKER = "WORKPILOT_SMOKE_OK";
const TIMEOUT_MS = Number(process.env.WORKPILOT_SMOKE_TIMEOUT_MS || 120_000);
const FRONTEND = path.resolve(__dirname, "..");

function packagedExecutable(platform, distDir) {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(FRONTEND, "package.json"), "utf8"),
	);
	const productName = pkg.build?.productName || pkg.productName || pkg.name;
	if (platform === "win32") {
		return [path.join(distDir, "win-unpacked", `${productName}.exe`)];
	}
	if (platform === "darwin") {
		return ["mac", "mac-arm64", "mac-universal"].map((dir) =>
			path.join(distDir, dir, `${productName}.app`, "Contents", "MacOS", productName),
		);
	}
	const executableName = pkg.build?.linux?.executableName || pkg.name;
	return [
		path.join(distDir, "linux-unpacked", executableName),
		path.join(distDir, "linux-unpacked", "workpilot-ai"),
	];
}

function resolveCommand(argv, platform) {
	if (argv.includes("--packaged")) {
		const candidates = packagedExecutable(platform, path.join(FRONTEND, "dist"));
		const found = candidates.find((candidate) => fs.existsSync(candidate));
		if (!found) {
			throw new Error(`no unpacked app found; looked for:\n  ${candidates.join("\n  ")}`);
		}
		return { command: found, args: [] };
	}
	const main = path.join(FRONTEND, "out", "main", "index.js");
	if (!fs.existsSync(main)) {
		throw new Error(`${main} is missing: run \`pnpm run build\` first`);
	}
	// The electron package's main export is the path of its binary.
	return { command: require("electron"), args: [FRONTEND] };
}

function run() {
	const platform = process.platform;
	const { command, args } = resolveCommand(process.argv.slice(2), platform);
	// CI runners have no SUID sandbox helper and no GPU.
	const extra = platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
	// A fresh profile: the smoke test must not depend on, or write to, the
	// settings of whoever runs it.
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "workpilot-smoke-"));

	console.log(`smoke test: ${command} ${[...args, ...extra].join(" ")}`);
	const child = spawn(command, [...args, ...extra, `--user-data-dir=${userData}`], {
		env: { ...process.env, WORKPILOT_SMOKE_TEST: "1", ELECTRON_ENABLE_LOGGING: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});

	let output = "";
	const collect = (chunk) => {
		const text = chunk.toString();
		output += text;
		process.stdout.write(text);
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	const timer = setTimeout(() => {
		console.error(`smoke test: no answer after ${TIMEOUT_MS} ms, killing the app`);
		child.kill("SIGKILL");
	}, TIMEOUT_MS);

	child.on("error", (error) => {
		clearTimeout(timer);
		console.error(`smoke test: could not start the app: ${error.message}`);
		process.exit(1);
	});
	child.on("exit", (code, signal) => {
		clearTimeout(timer);
		fs.rmSync(userData, { recursive: true, force: true });
		const ok = code === 0 && output.includes(OK_MARKER);
		if (ok) {
			console.log("smoke test: passed");
			process.exit(0);
		}
		console.error(
			`smoke test: failed (exit code ${code}, signal ${signal}, ` +
				`${output.includes(OK_MARKER) ? "" : "no "}${OK_MARKER})`,
		);
		process.exit(1);
	});
}

if (require.main === module) {
	try {
		run();
	} catch (error) {
		console.error(`smoke test: ${error.message}`);
		process.exit(1);
	}
}

module.exports = { packagedExecutable, resolveCommand };
