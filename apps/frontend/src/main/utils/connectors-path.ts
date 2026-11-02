/**
 * Where the shared Python connectors (`src/connectors`: Jira, Azure DevOps,
 * LLM provider config…) live, as the backend and the view runners import
 * them: `from src.connectors… import …`, with the directory holding `src` on
 * `sys.path`.
 *
 * In the repository, that directory is the repository root. The installed
 * app ships the package inside its backend (`resources/backend/src`, see
 * `extraResources` in package.json), so the backend directory, which every
 * runner already has on its path, holds it there.
 */
import { existsSync } from "node:fs";
import path from "node:path";

function hasConnectors(root: string): boolean {
	return existsSync(path.join(root, "src", "connectors"));
}

/** The directory to put on `sys.path` for `import src.connectors`. */
export function connectorsRoot(backendPath: string): string {
	const candidates = [
		backendPath,
		path.resolve(backendPath, "..", ".."),
		// The main bundle in the repository: apps/frontend/out/main.
		path.resolve(import.meta.dirname, "..", "..", "..", ".."),
	];
	return candidates.find(hasConnectors) ?? backendPath;
}
