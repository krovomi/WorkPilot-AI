import { resolve } from "node:path";

/**
 * Where the development `.env-files/.env` may live, nearest first.
 *
 * Empty for a packaged app: it loads no `.env` of its own, and never one from
 * the directory it happens to be launched from.
 */
export function devEnvFilePaths(
	mainDir: string,
	cwd: string,
	isPackaged: boolean,
): string[] {
	if (isPackaged) return [];
	return [
		resolve(mainDir, "../../../../.env-files/.env"), // out/main -> root/.env-files/.env
		resolve(mainDir, "../../../.env-files/.env"), // Alternative depth
		resolve(cwd, ".env-files/.env"), // From the workspace root (pnpm run dev)
	];
}
