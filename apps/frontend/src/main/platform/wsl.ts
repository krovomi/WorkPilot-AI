/**
 * WSL detection, in a module of its own: secret-storage.ts and
 * wsl-secret-key.ts need it without open-external.ts, whose import pulls in
 * Electron's shell and runs its own detection.
 */

import { readFileSync } from "node:fs";
import { isLinux } from "./index";

/** Ce processus est-il un Linux lancé sous WSL (1 ou 2) ? */
export function detectWsl(
	linux = isLinux(),
	env: NodeJS.ProcessEnv = process.env,
	readText: (file: string) => string = (file) => readFileSync(file, "utf8"),
): boolean {
	if (!linux) return false;
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	for (const probe of ["/proc/sys/kernel/osrelease", "/proc/version"]) {
		try {
			if (readText(probe).toLowerCase().includes("microsoft")) return true;
		} catch {
			// sonde absente : on essaie la suivante
		}
	}
	return false;
}

/** `[automount] root` de `/etc/wsl.conf`, sinon `/mnt/`. */
export function readAutomountRoot(
	readText: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string {
	let text: string;
	try {
		text = readText("/etc/wsl.conf");
	} catch {
		return "/mnt/";
	}
	let inAutomount = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const section = /^\[(.+)\]$/.exec(line);
		if (section) {
			inAutomount = section[1].trim().toLowerCase() === "automount";
			continue;
		}
		const entry = /^root\s*=\s*(.*)$/i.exec(line);
		if (inAutomount && entry) {
			const root = entry[1].trim().replace(/^["']|["']$/g, "");
			if (root) return root.endsWith("/") ? root : `${root}/`;
		}
	}
	return "/mnt/";
}

