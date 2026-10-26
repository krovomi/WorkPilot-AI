/**
 * One-shot approval tokens for a remote "approve the plan".
 *
 * A token names one task and one action, expires, and is gone once read: a
 * button tapped twice, or a message forwarded to someone else after use,
 * approves nothing. Tokens live in memory only; an app restart voids them.
 */
import { randomBytes } from "node:crypto";

export type RemoteAction = "approve_plan";

interface Pending {
	taskId: string;
	action: RemoteAction;
	expiresAt: number;
}

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 200;

export class ApprovalStore {
	private pending = new Map<string, Pending>();

	constructor(private readonly now: () => number = Date.now) {}

	issue(taskId: string, action: RemoteAction, ttlMs = APPROVAL_TTL_MS): string {
		// One live token per task and action: a new notification voids the old button.
		for (const [token, entry] of this.pending) {
			if (entry.taskId === taskId && entry.action === action) this.pending.delete(token);
		}
		while (this.pending.size >= MAX_PENDING) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) break;
			this.pending.delete(oldest);
		}
		// 16 bytes, base64url: 22 characters, inside Telegram's 64-byte callback data.
		const token = randomBytes(16).toString("base64url");
		this.pending.set(token, { taskId, action, expiresAt: this.now() + ttlMs });
		return token;
	}

	/** The task and action a token approves, once; null when unknown or expired. */
	consume(token: string): { taskId: string; action: RemoteAction } | null {
		const entry = this.pending.get(token);
		if (!entry) return null;
		this.pending.delete(token);
		if (entry.expiresAt <= this.now()) return null;
		return { taskId: entry.taskId, action: entry.action };
	}

	/** Void every token of a task: it left the state the button was about. */
	revoke(taskId: string): void {
		for (const [token, entry] of this.pending) {
			if (entry.taskId === taskId) this.pending.delete(token);
		}
	}
}
