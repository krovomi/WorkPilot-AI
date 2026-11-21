/**
 * The approval of a server card, and the approvals lent on a server project
 * (server mode). The server decides everything here
 * (`apps/backend/shared_board/approvals.py`): the app shows what it answers,
 * read field by field in the main process (`main/server-card-approvals.ts`).
 */

export const SERVER_CRITICALITIES = ["low", "medium", "high"] as const;
export type ServerCriticality = (typeof SERVER_CRITICALITIES)[number];

/** Who set a card's criticality: a person, the spec's assessment, or nobody. */
export type ServerCriticalitySource = "set" | "assessed" | "default";

export interface ServerApprovalEntry {
	by: string;
	/** The approver a delegate stood in for. */
	for: string | null;
	at: string;
	roles: string[];
}

export interface ServerCardApproval {
	criticality: ServerCriticality;
	criticalitySource: ServerCriticalitySource;
	needed: number;
	count: number;
	roles: string[];
	missingRoles: string[];
	approvals: ServerApprovalEntry[];
	complete: boolean;
	/** The build may start. */
	approved: boolean;
}

export interface ServerPerson {
	id: string;
	name: string;
}

export interface ServerDelegation {
	id: string;
	from: ServerPerson;
	to: ServerPerson;
	startsAt: string;
	endsAt: string;
	active: boolean;
}

export interface ServerDelegationInput {
	toUserId: string;
	/** ISO 8601 with a time zone. */
	endsAt: string;
	startsAt?: string;
}
