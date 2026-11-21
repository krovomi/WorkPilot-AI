/**
 * The static scan of an MCP Marketplace server's published code (issue #369,
 * lot 3).
 *
 * The main process reads the archive the registry publishes for the version
 * a catalog server runs (npm tarball, PyPI sdist or wheel), in memory, and
 * looks for a closed list of patterns in its JavaScript, TypeScript and
 * Python files (`shared/mcp-catalog/code-scan.ts`). Nothing of it is run or
 * written to disk.
 */

/**
 * - `shellExec`: starts other programs (child_process, subprocess, os.system…);
 * - `dynamicCode`: runs code it builds or loads at run time (eval, new Function,
 *   exec, an import whose name is not written in the code);
 * - `network`: opens network connections (information: most servers do);
 * - `fileWrite`: writes, moves or deletes files;
 * - `hardcodedSecret`: a string shaped like a credential (its value is never kept).
 */
export type McpCodeRule =
	| "shellExec"
	| "dynamicCode"
	| "network"
	| "fileWrite"
	| "hardcodedSecret";

export interface McpCodeFinding {
	rule: McpCodeRule;
	/** Path inside the package, without its top folder. */
	file: string;
	/** Line of the first match in that file. */
	line: number;
	/** Matches of the rule in that file. */
	count: number;
}

/** Why the code that would run could not be read. */
export type McpCodeUnavailableReason =
	| "missing"
	| "noArchive"
	| "unsupported"
	| "tooLarge"
	| "integrity";

export type McpCodeScan =
	| {
			status: "scanned";
			version: string;
			/** Source files read. */
			files: number;
			/** Files left out (too many, too large): the scan is partial. */
			skipped: number;
			findings: McpCodeFinding[];
			scannedAt: string;
	  }
	| {
			status: "unavailable";
			version: string;
			reason: McpCodeUnavailableReason;
			scannedAt: string;
	  };

/**
 * A finding the project's MCP policy accepts, with the reason someone wrote
 * (`.workpilot/mcp-policy.json`, `acceptedFindings`): a false positive of the
 * scan, or a use the team has reviewed.
 */
export interface McpAcceptedFinding {
	server: string;
	rule: McpCodeRule;
	reason: string;
}

/** What the score's details show of the scan. */
export interface McpCodeReport {
	version: string;
	files?: number;
	skipped?: number;
	reason?: McpCodeUnavailableReason;
	findings: (McpCodeFinding & { accepted?: string })[];
}
