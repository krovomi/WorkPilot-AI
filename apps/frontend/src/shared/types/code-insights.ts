/**
 * Code review and refactoring of the Development views, for every stack
 * (runners/code_insights_runner.py, through "codeInsights:run").
 */

export type CodeInsightsAction = "review" | "smells" | "propose" | "languages";

export interface CodeInsightsRequest {
	action: CodeInsightsAction;
	/** The patch (review) or the source snippet (smells, propose). */
	text?: string;
	/** A language id from "languages"; guessed from the text when absent. */
	language?: string;
}

export interface CodeReviewIssue {
	rule: string;
	severity: "critical" | "high" | "medium" | "low" | "info";
	message: string;
	file: string;
	line: number;
	suggestion: string;
}

export interface CodeReviewReport {
	score: number;
	passed: boolean;
	summary: string;
	issues: CodeReviewIssue[];
}

export interface CodeSmell {
	smell_type: string;
	severity: string;
	message: string;
	line?: number;
	symbol?: string | null;
	metric_value?: number;
	threshold?: number;
}

export interface RefactoringProposal {
	pattern: string;
	description: string;
	risk_level: string;
	symbol?: string | null;
	impact?: string | null;
}

export interface CodeLanguage {
	id: string;
	label: string;
}

export interface CodeInsightsResultMap {
	review: CodeReviewReport;
	smells: { language: string; smells: CodeSmell[] };
	propose: { language: string; proposals: RefactoringProposal[] };
	languages: { languages: CodeLanguage[] };
}
