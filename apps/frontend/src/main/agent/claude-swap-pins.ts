import type { AiAccountPins } from "../../shared/types/ai-accounts";

/**
 * Task → the Claude profile an auto-swap moved it to. A task whose card or
 * project pins a Claude profile would otherwise restart on that same, limited
 * profile: its next start takes the swapped one instead, once. The task's
 * file keeps its pin; the next run tries it again.
 */
export class ClaudeSwapPins {
	private readonly swaps = new Map<string, string>();

	remember(taskId: string, profileId: string): void {
		this.swaps.set(taskId, profileId);
	}

	/** `accounts` with the Claude pin replaced by the task's pending swap, if any. */
	apply(taskId: string | undefined, accounts: AiAccountPins | undefined): AiAccountPins | undefined {
		const swapped = taskId ? this.swaps.get(taskId) : undefined;
		if (!swapped || !accounts?.claude) return accounts;
		this.swaps.delete(taskId as string);
		return { ...accounts, claude: swapped };
	}
}
