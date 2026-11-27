/** What Settings, Approval tiers shows of Claude Ship's detection (`main/agent/approvals-env.ts`). */
export interface ClaudeShipStatus {
	/** A signed-in Claude account is on a Team or Enterprise organization. */
	detected: boolean;
	/** Those accounts, by name and plan: never a token. */
	accounts: { name: string; plan: "team" | "enterprise" }[];
}
