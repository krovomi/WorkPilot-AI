/**
 * Ideas of each type, as the main process hands them to the renderer
 * (`ipc-handlers/ideation/transformers.ts` fills every list).
 */
import type {
	CodeImprovementIdea,
	CodeQualityIdea,
	DocumentationGapIdea,
	IdeationSession,
	PerformanceOptimizationIdea,
	SecurityHardeningIdea,
	UIUXImprovementIdea,
} from "../../../../shared/types";

const BASE = {
	description: "What the idea changes",
	rationale: "Why it is worth it",
	status: "draft" as const,
	createdAt: new Date("2026-11-01T10:00:00Z"),
};

export function codeImprovement(
	over: Partial<CodeImprovementIdea> = {},
): CodeImprovementIdea {
	return {
		...BASE,
		id: "ci-1",
		type: "code_improvements",
		title: "Reuse the retry helper",
		buildsUpon: ["retry helper"],
		estimatedEffort: "large",
		affectedFiles: ["src/net/fetch.ts"],
		existingPatterns: ["withRetry wrapper"],
		implementationApproach: "Wrap each call in withRetry",
		...over,
	};
}

export function uiux(over: Partial<UIUXImprovementIdea> = {}): UIUXImprovementIdea {
	return {
		...BASE,
		id: "ux-1",
		type: "ui_ux_improvements",
		title: "Label the icon buttons",
		category: "accessibility",
		affectedComponents: ["Toolbar"],
		currentState: "Buttons have no name",
		proposedChange: "Give each an aria-label",
		userBenefit: "Screen readers announce them",
		...over,
	};
}

export function docGap(over: Partial<DocumentationGapIdea> = {}): DocumentationGapIdea {
	return {
		...BASE,
		id: "doc-1",
		type: "documentation_gaps",
		title: "Document the config file",
		category: "api_docs",
		targetAudience: "maintainers",
		affectedAreas: ["config/"],
		currentDocumentation: "Only a stub",
		proposedContent: "Every key with an example",
		priority: "high",
		estimatedEffort: "trivial",
		...over,
	};
}

export function security(
	over: Partial<SecurityHardeningIdea> = {},
): SecurityHardeningIdea {
	return {
		...BASE,
		id: "sec-1",
		type: "security_hardening",
		title: "Escape the search query",
		category: "input_validation",
		severity: "critical",
		affectedFiles: ["src/search.ts"],
		vulnerability: "CWE-79",
		currentRisk: "A query can inject markup",
		remediation: "Escape before rendering",
		references: ["https://owasp.org/xss", "CWE-79"],
		compliance: ["SOC2"],
		...over,
	};
}

export function perf(
	over: Partial<PerformanceOptimizationIdea> = {},
): PerformanceOptimizationIdea {
	return {
		...BASE,
		id: "perf-1",
		type: "performance_optimizations",
		title: "Cache the project list",
		category: "caching",
		impact: "high",
		affectedAreas: ["stores/project-store.ts"],
		currentMetric: "300 ms per open",
		expectedImprovement: "10 ms per open",
		implementation: "Memoise the read",
		tradeoffs: "Stale for one second",
		estimatedEffort: "small",
		...over,
	};
}

export function codeQuality(over: Partial<CodeQualityIdea> = {}): CodeQualityIdea {
	return {
		...BASE,
		id: "cq-1",
		type: "code_quality",
		title: "Split the big store",
		category: "large_files",
		severity: "major",
		affectedFiles: ["stores/task-store.ts"],
		currentState: "1 800 lines",
		proposedChange: "One module per concern",
		codeExample: "export const useTaskStore = create(...)",
		bestPractice: "Small modules",
		metrics: { lineCount: 0, complexity: 12, duplicateLines: 40, testCoverage: 55 },
		estimatedEffort: "medium",
		breakingChange: true,
		prerequisites: ["Freeze the API"],
		...over,
	};
}

export function session(
	ideas: IdeationSession["ideas"],
	projectId = "p1",
): IdeationSession {
	return {
		id: `session-${projectId}`,
		projectId,
		config: {
			enabledTypes: ["code_improvements"],
			includeRoadmapContext: true,
			includeKanbanContext: true,
			maxIdeasPerType: 5,
		},
		ideas,
		projectContext: { existingFeatures: [], techStack: [], plannedFeatures: [] },
		generatedAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
	};
}
