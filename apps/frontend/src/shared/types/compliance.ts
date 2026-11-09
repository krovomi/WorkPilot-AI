/**
 * Compliance evidence collector (#357): the frameworks, the dated evidence,
 * each control's verdict and the gaps, as `compliance_collector/` writes them.
 */

export interface ComplianceFrameworkInfo {
	id: string;
	name: string;
	version: string;
	controls: number;
	/** "bundled", or the project file it came from. */
	source: string;
}

export interface ComplianceConfig {
	frameworks: string[];
	monthly: boolean;
}

export interface ComplianceFrameworks {
	frameworks: ComplianceFrameworkInfo[];
	config: ComplianceConfig;
	/** Project framework files that were skipped, and why. */
	errors: string[];
}

export type EvidenceKind =
	| "spec_approval"
	| "code_review"
	| "tests"
	| "security"
	| "security_config"
	| "change"
	| "merge"
	| "release"
	| "deployment"
	| "access"
	| "policy"
	| "procedure"
	| "incident"
	| "monitoring";

export type ControlStatus = "covered" | "failing" | "stale" | "missing";

export interface ComplianceEvidence {
	kind: EvidenceKind;
	at: string;
	title: string;
	source: string;
	outcome: "pass" | "fail" | "info";
	actor?: string;
	task?: string;
}

export interface Words {
	en?: string;
	fr?: string;
}

export interface ControlCheck {
	kinds: EvidenceKind[];
	status: ControlStatus;
	lastEvidenceAt: string | null;
	ageDays: number | null;
	count: number;
}

export interface ComplianceControl {
	id: string;
	title: Words;
	requirements: EvidenceKind[][];
	maxAgeDays: number;
	recommendation: Words;
	status: ControlStatus;
	checks: ControlCheck[];
	lastEvidenceAt: string | null;
	ageDays: number | null;
	alert: boolean;
	periodCount: number;
	failures: number;
	evidence: ComplianceEvidence[];
}

export interface ComplianceGap {
	controlId: string;
	title: Words;
	status: Exclude<ControlStatus, "covered">;
	ageDays: number | null;
	alert: boolean;
	missingKinds: EvidenceKind[];
	recommendation: Words;
}

export interface ComplianceSummary {
	controls: number;
	covered: number;
	failing: number;
	stale: number;
	missing: number;
	alerts: number;
	evidence: number;
	byKind: Partial<Record<EvidenceKind, number>>;
	specApprovals: number;
	reviewsApproved: number;
	reviewsRejected: number;
	testsPassed: number;
	testsFailed: number;
	securityFindings: number;
	tasks: number;
}

export interface ComplianceReport {
	version: number;
	framework: ComplianceFrameworkInfo;
	period: { label: string; start: string; end: string };
	generatedAt: string;
	coveragePercent: number;
	summary: ComplianceSummary;
	risks: string[];
	gaps: ComplianceGap[];
	controls: ComplianceControl[];
	warnings: string[];
	/** The file name, once saved under `.workpilot/compliance/reports/`. */
	saved?: string;
}

export interface ComplianceReportListing {
	name: string;
	framework: string;
	period: string;
	generatedAt: string | null;
	coveragePercent: number | null;
	gaps: number;
	alerts: number;
}

export type ComplianceExportFormat = "json" | "csv" | "html" | "pdf";

/** The report worded in the app's language, for CSV, HTML and PDF. */
export interface ComplianceExportDocument {
	title: string;
	summary: string[];
	tables: { title: string; columns: string[]; rows: string[][] }[];
}
