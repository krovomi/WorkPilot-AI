/**
 * API Contract Watcher — Types for contract diff and migration guides.
 */

export type ContractFormat = "openapi" | "graphql" | "protobuf" | "unknown";

export type ChangeCategory =
	| "breaking"
	| "potentially_breaking"
	| "non_breaking";

export type ChangeType =
	| "endpoint_removed"
	| "endpoint_added"
	| "endpoint_deprecated"
	| "parameter_added_required"
	| "parameter_removed"
	| "type_removed"
	| "type_added"
	| "field_removed"
	| "field_added"
	| "field_type_changed"
	| "field_required_added"
	| "field_deprecated"
	| "field_renamed"
	| "field_number_changed"
	| "parameter_became_required"
	| "parameter_type_changed"
	| "request_body_changed"
	| "response_status_added"
	| "response_status_removed"
	| "response_type_changed"
	| "enum_value_added"
	| "enum_value_removed"
	| "contract_added"
	| "contract_removed";

/** Who uses what broke: a registry entry, or a top-level folder of the repo. */
export interface ContractConsumer {
	name: string;
	contact: string;
	files: string[];
}

export interface ContractChange {
	changeType: ChangeType;
	category: ChangeCategory;
	path: string;
	description: string;
	oldValue?: string;
	newValue?: string;
	/** The new contract declares it intended (`x-breaking-acknowledged`). */
	acknowledged?: boolean;
	consumers?: ContractConsumer[];
}

/** One contract file compared with the target branch (#389). */
export interface ContractReportEntry {
	path: string;
	format: ContractFormat | "raml" | "wsdl" | "thrift";
	status: "changed" | "added" | "removed" | "unsupported";
	oldVersion: string;
	newVersion: string;
	changes: ContractChange[];
	breakingCount: number;
	potentiallyBreakingCount: number;
	nonBreakingCount: number;
	unacknowledgedBreakingCount: number;
	linesAdded: number;
	linesRemoved: number;
}

export interface ContractCompareReport {
	status: "pass" | "review" | "breaking" | "unchecked";
	base: string;
	target: string;
	unchecked: string;
	checkedAt: string;
	contracts: ContractReportEntry[];
	breakingCount: number;
	potentiallyBreakingCount: number;
	nonBreakingCount: number;
	unacknowledgedBreakingCount: number;
	registry: { source: string; consumers: number; errors: string[] };
}

export interface ContractDiff {
	oldVersion: string;
	newVersion: string;
	format: ContractFormat;
	changes: ContractChange[];
	breakingCount: number;
	potentiallyBreakingCount: number;
	nonBreakingCount: number;
}

export interface MigrationGuide {
	markdown: string;
	breakingChanges: ContractChange[];
	generatedAt: string;
}
