/**
 * Documentation agent — coverage and drafts for every language in
 * apps/backend/doc_languages (runners/documentation_runner.py).
 */

export type DocSymbolStatus = "documented" | "partial" | "missing";

export interface DocSymbol {
	name: string;
	symbol_type: string;
	language: string;
	file_path: string;
	line_number: number;
	status: DocSymbolStatus;
	existing_doc: string;
	generated_doc: string;
	args: string[];
	return_type: string | null;
}

export interface DocCounts {
	total: number;
	documented: number;
	partial: number;
	missing: number;
	coverage_pct: number;
}

export interface DocLanguageCoverage extends DocCounts {
	id: string;
	label: string;
	files: number;
}

export interface DocFileCoverage extends DocCounts {
	path: string;
	language: string;
}

export interface DocProjectOverview extends DocCounts {
	files_scanned: number;
	files_with_symbols: number;
	truncated: boolean;
	languages: DocLanguageCoverage[];
	files: DocFileCoverage[];
}

export interface DocFileReport extends DocCounts {
	path: string;
	language: string | null;
	symbols: DocSymbol[];
}

export interface DocDraftResult {
	source_path: string;
	symbols_analyzed: number;
	symbols_documented: number;
	symbols_already_documented: number;
	generated_docs: DocSymbol[];
}

export interface DocReadmeResult {
	source_path: string;
	readme_content: string;
	diagram_content: string;
}

export type DocumentationAction = "project" | "coverage" | "docstrings" | "readme";

export interface DocumentationRequest {
	projectPath: string;
	action: DocumentationAction;
	/** Project-relative file (coverage, docstrings) or folder (readme). */
	path?: string;
}

export interface DocumentationResultMap {
	project: DocProjectOverview;
	coverage: DocFileReport;
	docstrings: DocDraftResult;
	readme: DocReadmeResult;
}
