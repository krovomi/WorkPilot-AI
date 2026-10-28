/**
 * Remote approval through Telegram, by polling: WorkPilot asks Telegram for
 * the button presses (`getUpdates`), so nothing on the machine listens.
 *
 * A press approves only when every one of these holds:
 *  - it comes from the configured chat id, which is the user's own id (a
 *    private chat with the bot): someone added to a group cannot approve;
 *  - its token is one this app issued, unused and not expired;
 *  - the task is still waiting for that approval (checked again by the
 *    approver, at the moment of the press).
 */
import type { ApprovalStore } from "./approvals";
import { type Fetch, type TelegramTarget, telegramCall } from "./channels";
import type { ReplyKey } from "./events";

export type ApprovalOutcome = "approved" | "notPending" | "appClosed";

export interface PollerDeps {
	approvals: ApprovalStore;
	approve: (taskId: string) => Promise<ApprovalOutcome>;
	reply: (key: ReplyKey) => string;
	fetch?: Fetch;
	log?: (message: string, error?: unknown) => void;
}

interface CallbackQuery {
	id: string;
	from?: { id?: number };
	data?: string;
	message?: { message_id?: number; chat?: { id?: number; type?: string } };
}

interface Update {
	update_id: number;
	callback_query?: CallbackQuery;
}

const LONG_POLL_S = 50;

export class TelegramApprovalPoller {
	private target: TelegramTarget | null = null;
	private offset = 0;
	private running = false;
	private generation = 0;

	constructor(private readonly deps: PollerDeps) {}

	/** Start, restart on a new target, or stop with null. */
	configure(target: TelegramTarget | null): void {
		const same =
			target && this.target && target.botToken === this.target.botToken && target.chatId === this.target.chatId;
		if (same && this.running) return;
		this.target = target;
		this.generation += 1;
		this.running = false;
		if (target) void this.loop(this.generation);
	}

	stop(): void {
		this.configure(null);
	}

	/** One press. Exported through the class for the tests. */
	async handle(query: CallbackQuery, target: TelegramTarget): Promise<void> {
		const { reply } = this.deps;
		const answer = (key: ReplyKey) =>
			telegramCall(target, "answerCallbackQuery", { callback_query_id: query.id, text: reply(key) }, this.deps.fetch);

		const fromChat = String(query.message?.chat?.id ?? "");
		const fromUser = String(query.from?.id ?? "");
		if (fromChat !== target.chatId || fromUser !== target.chatId) {
			// Not the configured person: say nothing about what the token was.
			this.deps.log?.(`[NeedsYou] Ignored a button press from chat ${fromChat}`);
			await answer("expired");
			return;
		}
		const token = query.data?.startsWith("approve:") ? query.data.slice("approve:".length) : "";
		const pending = token ? this.deps.approvals.consume(token) : null;
		if (!pending) {
			await answer("expired");
			return;
		}
		const outcome = await this.deps.approve(pending.taskId);
		await answer(outcome);
		if (query.message?.message_id !== undefined) {
			// The button goes: it has done what it could, whatever the outcome.
			await telegramCall(
				target,
				"editMessageReplyMarkup",
				{ chat_id: target.chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } },
				this.deps.fetch,
			);
		}
	}

	private async loop(generation: number): Promise<void> {
		this.running = true;
		let backoff = 5_000;
		while (generation === this.generation && this.target) {
			const target = this.target;
			try {
				const result = await telegramCall(
					target,
					"getUpdates",
					{ offset: this.offset, timeout: LONG_POLL_S, allowed_updates: ["callback_query"] },
					this.deps.fetch,
					(LONG_POLL_S + 10) * 1000,
				);
				if (generation !== this.generation) return;
				if (!result.ok || !Array.isArray(result.result)) throw new Error("getUpdates failed");
				for (const update of result.result as Update[]) {
					this.offset = Math.max(this.offset, update.update_id + 1);
					if (update.callback_query) await this.handle(update.callback_query, target);
				}
				backoff = 5_000;
			} catch (error) {
				if (generation !== this.generation) return;
				this.deps.log?.("[NeedsYou] Telegram polling failed", error);
				await new Promise((resolve) => setTimeout(resolve, backoff));
				backoff = Math.min(backoff * 2, 60_000);
			}
		}
	}
}
