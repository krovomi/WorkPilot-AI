/**
 * Quality Scorer API
 * Exposes the AI Code Review Quality Scorer functionality to the renderer
 */

import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface QualityIssue {
	category: "bugs" | "security" | "maintainability" | "complexity";
	severity: "critical" | "high" | "medium" | "low";
	title: string;
	description: string;
	file: string;
	line: number | null;
	suggestion: string | null;
}

export interface QualityScore {
	overall_score: number; // 0-100
	grade: string; // A+, A, B+, B, C, D, F
	total_issues: number;
	critical_issues: number;
	is_passing: boolean;
	issues: QualityIssue[];
}

export interface QualityAPI {
	/**
	 * Analyze code quality for given files
	 * @param files Array of file paths to analyze
	 * @param projectDir Project directory path
	 * @returns Quality score and issues
	 */
	analyzeQuality(files: string[], projectDir?: string): Promise<QualityScore>;

	/**
	 * Analyze code quality for a PR
	 * @param prNumber PR number
	 * @param changedFiles Array of changed files
	 * @param projectDir Project directory path
	 * @returns Quality score and issues
	 */
	analyzePRQuality(
		prNumber: number,
		changedFiles: string[],
		projectDir?: string,
	): Promise<QualityScore>;
}

export const createQualityAPI = (): QualityAPI => ({
	analyzeQuality: (files: string[], projectDir?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.QUALITY_ANALYZE, { files, projectDir }),

	analyzePRQuality: (
		prNumber: number,
		changedFiles: string[],
		projectDir?: string,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.QUALITY_ANALYZE_PR, {
			prNumber,
			changedFiles,
			projectDir,
		}),
});
