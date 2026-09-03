import { statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readFile, walkFiles } from "./source-files";

/**
 * An OpenAPI or Swagger document committed to the repository.
 *
 * A spec the team wrote and versions is the only description of an API that
 * needs no guessing: it states the paths, the parameters and the schemas
 * outright. Every heuristic in this folder exists because most projects do
 * not have one — when they do, reading it beats inferring it.
 */
export interface DiscoveredSpec {
	/** Absolute path of the file the document was read from. */
	file: string;
	/** Path relative to the project root, for display. */
	relativePath: string;
	document: Record<string, unknown>;
	dialect: "openapi3" | "swagger2";
	pathCount: number;
}

/** File names that hold an API description, whatever the directory. */
const SPEC_BASENAMES = new Set([
	"openapi",
	"openapi.gen",
	"openapi-spec",
	"swagger",
	"swagger-spec",
	"api-docs",
	"apidocs",
	"api-spec",
]);

const SPEC_EXTENSIONS = [".json", ".yaml", ".yml"];

/**
 * Specs are text and rarely large; anything past this is a data dump that
 * happens to be called `swagger.json`, and parsing it would block the main
 * process for no gain.
 */
const MAX_SPEC_BYTES = 8 * 1024 * 1024;

/**
 * A YAML document may expand exponentially through aliases — the "billion
 * laughs" shape. The parser caps that by default; the cap is restated here so
 * that reading an untrusted repository cannot become an outage.
 */
const MAX_YAML_ALIASES = 100;

function isSpecFileName(filePath: string): boolean {
	const extension = path.extname(filePath).toLowerCase();
	if (!SPEC_EXTENSIONS.includes(extension)) return false;
	const base = path.basename(filePath, extension).toLowerCase();
	if (SPEC_BASENAMES.has(base)) return true;
	// `openapi.v1`, `swagger-v2`, `api-docs.public`…
	return [...SPEC_BASENAMES].some(
		(name) => base.startsWith(`${name}.`) || base.startsWith(`${name}-`),
	);
}

function parseDocument(
	filePath: string,
	content: string,
): Record<string, unknown> | null {
	try {
		const parsed = path.extname(filePath).toLowerCase() === ".json"
			? JSON.parse(content)
			: parseYaml(content, { maxAliasCount: MAX_YAML_ALIASES });
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		// A file named like a spec that does not parse is not a spec. Silence is
		// correct here: the scan continues to the next candidate.
		return null;
	}
}

/** The dialect of a document, or `null` when it describes no API at all. */
export function specDialect(
	document: Record<string, unknown>,
): DiscoveredSpec["dialect"] | null {
	const paths = document.paths;
	if (!paths || typeof paths !== "object" || Array.isArray(paths)) return null;
	if (Object.keys(paths).length === 0) return null;

	const openapi = document.openapi;
	if (typeof openapi === "string" && openapi.startsWith("3")) return "openapi3";
	const swagger = document.swagger;
	if (typeof swagger === "string" && swagger.startsWith("2")) return "swagger2";
	return null;
}

/**
 * Ranks two documents that both describe an API. OpenAPI 3 comes first, then
 * the one covering more paths, then the one nearer the project root — a spec
 * at the top level is the project's own, one buried under `examples/` usually
 * is not.
 */
function isBetter(candidate: DiscoveredSpec, best: DiscoveredSpec): boolean {
	if (candidate.dialect !== best.dialect) return candidate.dialect === "openapi3";
	if (candidate.pathCount !== best.pathCount) {
		return candidate.pathCount > best.pathCount;
	}
	const candidateDepth = candidate.relativePath.split(/[\\/]/).length;
	const bestDepth = best.relativePath.split(/[\\/]/).length;
	if (candidateDepth !== bestDepth) return candidateDepth < bestDepth;
	// Deterministic: two equally good specs must not depend on directory order.
	return candidate.relativePath.localeCompare(best.relativePath) < 0;
}

/**
 * Finds the API description the repository already carries, if any.
 *
 * Never throws: an unreadable file, a truncated document or YAML that expands
 * without end is skipped, and the search moves on.
 */
export function findCommittedSpec(projectPath: string): DiscoveredSpec | null {
	let best: DiscoveredSpec | null = null;

	for (const file of walkFiles(projectPath, SPEC_EXTENSIONS)) {
		if (!isSpecFileName(file)) continue;

		try {
			if (statSync(file).size > MAX_SPEC_BYTES) continue;
		} catch {
			continue;
		}

		const content = readFile(file);
		if (!content) continue;

		const document = parseDocument(file, content);
		if (!document) continue;

		const dialect = specDialect(document);
		if (!dialect) continue;

		const candidate: DiscoveredSpec = {
			file,
			relativePath: path.relative(projectPath, file),
			document,
			dialect,
			pathCount: Object.keys(document.paths as object).length,
		};
		if (!best || isBetter(candidate, best)) best = candidate;
	}

	return best;
}
