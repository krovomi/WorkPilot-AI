// Cross-platform backend dev server launcher for pnpm
// Ensures Python venv is activated and dependencies are installed before running Uvicorn

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkDevPort,
	DEV_HOST,
	DEV_PORT,
	exitCodeAfterUvicorn,
} from "./dev-port.mjs";
import { devReloadArgs } from "./dev-reload-args.mjs";

const isWin = process.platform === "win32";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const venvDir = resolve(__dirname, "../../.venv");
const requirements = resolve(__dirname, "requirements.txt");

function venvPython() {
	if (isWin) {
		return join(venvDir, "Scripts", "python.exe");
	} else {
		return join(venvDir, "bin", "python");
	}
}

function ensureVenv(cb) {
	if (!existsSync(venvPython())) {
		console.log("[INFO] Creating Python venv...");
		const py = isWin ? "python" : "python3";
		const proc = spawn(py, ["-m", "venv", venvDir], { stdio: "inherit" });
		proc.on("exit", (code) => {
			if (code === 0) cb();
			else process.exit(code);
		});
	} else {
		cb();
	}
}

function ensureDeps(cb) {
	const pip = venvPython();
	const proc = spawn(pip, ["-m", "pip", "install", "-r", requirements], {
		stdio: "inherit",
	});
	proc.on("exit", (code) => {
		if (code === 0) cb();
		else process.exit(code);
	});
}

function runUvicorn() {
	const uvicornArgs = [
		"-m",
		"uvicorn",
		"provider_api:app",
		"--host",
		DEV_HOST,
		"--port",
		String(DEV_PORT),
		// Watch only the backend source directory; the shared virtualenv lives at
		// the repo root (../../.venv). Why the .venv exclude is conditional:
		// dev-reload-args.mjs.
		...devReloadArgs(__dirname),
	];
	const proc = spawn(venvPython(), uvicornArgs, {
		stdio: "inherit",
		cwd: __dirname,
	});
	// A busy port fails uvicorn with exit code 3; why that is not always a
	// failure of `pnpm run dev`: dev-port.mjs.
	proc.on("exit", async (code) => process.exit(await exitCodeAfterUvicorn(code)));
}

const port = await checkDevPort();
if (port.start) ensureVenv(() => ensureDeps(runUvicorn));
else process.exit(port.exitCode);
