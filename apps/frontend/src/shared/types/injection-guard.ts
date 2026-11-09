/**
 * Prompt Injection Guard — Types for injection detection.
 */

export type ThreatLevel = "safe" | "suspect" | "blocked";

export interface ScanFinding {
	layer: "regex" | "classifier" | "decode";
	description: string;
	severity: "low" | "medium" | "high" | "critical";
	confidence: number;
}

export interface InjectionScanResult {
	threatLevel: ThreatLevel;
	findings: ScanFinding[];
	scannedText: string;
	source: string;
	decodedContent: string;
	timestamp: string;
}

/** A tool result an agent read that the guard flagged (`injection_alerts.jsonl`). */
export interface ToolResultAlert {
	spec: string;
	at: string;
	tool: string;
	source: string;
	level: "suspect" | "blocked";
	findings: string[];
	action: "fenced" | "withheld";
}
