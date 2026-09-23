export type JevMode = "inherit" | "enabled" | "bypass";
export interface JevSettings {
	enabled: boolean;
	workflows?: Record<string, JevMode>;
	model?: string;
	minimumConfidence?: number;
	timeoutSeconds?: number;
}
export interface JevCredentialStatus {
	configured: boolean;
	secureStorageAvailable: boolean;
}
export interface JevObservation {
	version: 1;
	runId: string;
	workflow: string;
	evaluations: Array<{
		point: string;
		passId: string;
		revision: string;
		status: "evaluated" | "bypassed";
		reason?: string;
		createdAt: string;
		answers?: Record<string, { value: string | number; confidence?: number }>;
	}>;
}
