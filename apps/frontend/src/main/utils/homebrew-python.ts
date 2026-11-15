/**
 * Homebrew Python Detection Utility
 *
 * Shared logic for finding Python installations in Homebrew directories.
 * Used by both python-detector.ts and cli-tool-manager.ts to ensure
 * consistent Python detection across the application.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Validation result for a Python installation.
 */
export interface PythonValidation {
	valid: boolean;
	version?: string;
	message: string;
}

/**
 * The Homebrew Python executables to try, best first: Apple Silicon then Intel,
 * newest version first (3.14, 3.13, 3.12), then the generic python3. Older
 * versions fail validation anyway.
 *
 * Note: This list should be updated when new Python versions are released.
 */
export function homebrewPythonCandidates(): string[] {
	const homebrewDirs = [
		"/opt/homebrew/bin", // Apple Silicon (M1/M2/M3)
		"/usr/local/bin", // Intel Mac
	];
	const pythonNames = ["python3.14", "python3.13", "python3.12", "python3"];
	return homebrewDirs.flatMap((dir) =>
		pythonNames.map((name) => path.join(dir, name)),
	);
}

/**
 * Find the first valid Homebrew Python installation (see
 * homebrewPythonCandidates for the order).
 *
 * @param validateFn - Function to validate a Python path and return validation result
 * @param logPrefix - Prefix for log messages (e.g., '[Python]', '[CLI Tools]')
 * @returns The path to Homebrew Python, or null if not found
 */
export function findHomebrewPython(
	validateFn: (pythonPath: string) => PythonValidation,
	logPrefix: string,
): string | null {
	for (const pythonPath of homebrewPythonCandidates()) {
		if (existsSync(pythonPath)) {
			try {
				// Validate that this Python meets version requirements
				const validation = validateFn(pythonPath);
				if (validation.valid) {
					return pythonPath;
				}
				console.warn(
					`${logPrefix} ${pythonPath} rejected: ${validation.message}`,
				);
			} catch (error) {
				// Version check failed (e.g., timeout, permission issue), try next candidate
				console.warn(`${logPrefix} Failed to validate ${pythonPath}: ${error}`);
			}
		}
	}
	return null;
}
