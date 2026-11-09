/**
 * Documentation Drift Detector — Types for doc-code drift detection (#354).
 */

import type { GeneratedReview } from "./generated-review";

export type DriftType =
	| "stale_reference"
	| "missing_function"
	| "signature_mismatch"
	| "type_mismatch"
	| "undocumented_param"
	| "example_syntax"
	| "example_import"
	| "example_arguments"
	| "stale_doc"
	| "doc_not_updated"
	| "outdated_example"
	| "broken_link"
	| "version_mismatch"
	| "missing_docs"
	| "config_mismatch";

export type DriftSeverity = "high" | "medium" | "low";

/** How the page groups the drift types. */
export type DriftFamily = "references" | "signatures" | "examples" | "stale";

export const DRIFT_FAMILY: Record<DriftType, DriftFamily> = {
	stale_reference: "references",
	missing_function: "references",
	broken_link: "references",
	signature_mismatch: "signatures",
	type_mismatch: "signatures",
	undocumented_param: "signatures",
	missing_docs: "signatures",
	example_syntax: "examples",
	example_import: "examples",
	example_arguments: "examples",
	outdated_example: "examples",
	config_mismatch: "examples",
	version_mismatch: "examples",
	stale_doc: "stale",
	doc_not_updated: "stale",
};

export interface DriftIssue {
	driftType: DriftType;
	severity: DriftSeverity;
	/** The document, or the source file for a doc comment. */
	docFile: string;
	docLine: number;
	referencedSymbol: string;
	/** English, for older reports; the page words it from `driftType` and `params`. */
	message: string;
	suggestion: string;
	/** Values the page's sentence for this type takes. */
	params?: Record<string, string | number>;
	/** Set when the drift can be fixed on a review card. */
	fixId?: string;
	/** stale_doc / doc_not_updated: the code files that moved. */
	files?: string[];
	/** stale_doc: the first commit after the document (seconds). */
	since?: number;
}

export interface DocFreshness {
	docFile: string;
	/** 0 to 100. */
	score: number;
	/** Last commit of the document (seconds), when git knows it. */
	lastUpdated?: number | null;
	staleSince?: number | null;
	/** `fr` for `README.fr.md` or `docs/fr/…`; empty for the reference language. */
	locale: string;
	issues: number;
}

export interface DriftReport {
	docsScanned: number;
	codeFilesIndexed: number;
	/** Symbols indexed across every language (absent in older reports). */
	symbolsIndexed?: number;
	/** Source files per language, most first. */
	languages?: { label: string; files: number }[];
	/** The documents compared (project-relative). */
	docFiles?: string[];
	issues: DriftIssue[];
	summary: string;
	freshness?: DocFreshness[];
	averageFreshness?: number | null;
	fixable?: number;
	/** Whether git history was read (stale documents need it). */
	git?: boolean;
}

export interface DocDriftFixRequest {
	projectPath: string;
	fixIds: string[];
}

export interface DocDriftFixOutcome {
	applied: { fixId: string; kind: string; file: string; line: number }[];
	/** Fixes asked for that the review branch no longer has. */
	missing: string[];
	review: GeneratedReview | null;
}

export type DocDriftExportFormat = "json" | "html";
