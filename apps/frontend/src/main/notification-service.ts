/**
 * "Needs you" notifications: on the desktop, and on ntfy or Telegram.
 *
 * One event per moment a task waits for a person (`needs-you/events.ts`),
 * read from the task's state machine when it settles. It used to be read from
 * the agent process's exit code, which called a plan waiting for approval a
 * failure and missed a QA that handed over without crashing.
 *
 * A plan waiting for approval can be approved from Telegram: the message
 * carries a one-shot button (`needs-you/approvals.ts`), and the press comes
 * back by polling (`needs-you/telegram-poller.ts`). Nothing else can be
 * approved from afar: a finished task's review leads to a merge.
 */
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { ipcMain, Notification, shell } from "electron";
import { IPC_CHANNELS } from "../shared/constants";
import type { AppSettings, NeedsYouTestResult, NotificationSettings } from "../shared/types";
import { getAppLanguage } from "./app-language";
import { appLog } from "./app-logger";
import { ApprovalStore } from "./needs-you/approvals";
import { ntfyTarget, sendNtfy, sendTelegram, telegramTarget } from "./needs-you/channels";
import {
	message,
	type NeedsYouEvent,
	type NeedsYouKind,
	remotelyApprovable,
	reply,
	testMessage,
} from "./needs-you/events";
import { type ApprovalOutcome, TelegramApprovalPoller } from "./needs-you/telegram-poller";
import { projectStore } from "./project-store";
import { readSettingsFile } from "./settings-utils";

const DEFAULT_NOTIFICATIONS: NotificationSettings = {
	onTaskComplete: true,
	onTaskFailed: true,
	onReviewNeeded: true,
	sound: false,
};

/** Which of the existing switches covers which kind. */
export function kindEnabled(kind: NeedsYouKind, settings: NotificationSettings): boolean {
	switch (kind) {
		case "completed":
			return settings.onTaskComplete;
		case "failed":
			return settings.onTaskFailed;
		default:
			return settings.onReviewNeeded;
	}
}

const APPROVAL_REPLY_TIMEOUT_MS = 30_000;

class NotificationService {
	private mainWindow: (() => BrowserWindow | null) | null = null;
	private isAwaitingPlanApproval: (taskId: string) => boolean = () => false;
	private readonly approvals = new ApprovalStore();
	private readonly waiting = new Map<string, (outcome: ApprovalOutcome) => void>();
	private readonly poller = new TelegramApprovalPoller({
		approvals: this.approvals,
		approve: (taskId) => this.approvePlan(taskId),
		reply: (key) => reply(key, getAppLanguage()),
		log: (text, error) => appLog.warn(text, error ?? ""),
	});

	initialize(
		getMainWindow: () => BrowserWindow | null,
		isAwaitingPlanApproval?: (taskId: string) => boolean,
	): void {
		this.mainWindow = getMainWindow;
		if (isAwaitingPlanApproval) this.isAwaitingPlanApproval = isAwaitingPlanApproval;
		// The renderer reports how an approval it was asked to apply went.
		ipcMain.removeHandler(IPC_CHANNELS.NEEDS_YOU_APPROVAL_RESULT);
		ipcMain.handle(
			IPC_CHANNELS.NEEDS_YOU_APPROVAL_RESULT,
			async (_, requestId: unknown, outcome: unknown) => {
				if (typeof requestId !== "string") return;
				const resolve = this.waiting.get(requestId);
				if (!resolve) return;
				this.waiting.delete(requestId);
				resolve(outcome === "approved" ? "approved" : "notPending");
			},
		);
		ipcMain.removeHandler(IPC_CHANNELS.NEEDS_YOU_TEST);
		ipcMain.handle(IPC_CHANNELS.NEEDS_YOU_TEST, () => this.test());
		this.refreshRemote();
	}

	/**
	 * Send one message on each configured channel, from the saved settings
	 * (never from values the renderer passes: the tokens stay in main).
	 */
	async test(): Promise<NeedsYouTestResult> {
		const settings = this.appSettings();
		const ntfy = ntfyTarget(settings.needsYou, settings.globalNtfyAccessToken);
		const telegram = telegramTarget(settings.needsYou, settings.globalTelegramBotToken);
		const text = testMessage(getAppLanguage());
		const outcome = async (send: Promise<boolean> | null) => {
			if (!send) return "off" as const;
			try {
				return (await send) ? ("sent" as const) : ("failed" as const);
			} catch {
				return "failed" as const;
			}
		};
		const [ntfyResult, telegramResult] = await Promise.all([
			outcome(ntfy ? sendNtfy(ntfy, text.title, text.body) : null),
			outcome(telegram ? sendTelegram(telegram, text.title, text.body) : null),
		]);
		return { ntfy: ntfyResult, telegram: telegramResult };
	}

	/** Re-read the remote settings: on start, and after every settings save. */
	refreshRemote(): void {
		const settings = this.appSettings();
		const telegram = telegramTarget(settings.needsYou, settings.globalTelegramBotToken);
		this.poller.configure(telegram && settings.needsYou?.telegram?.remoteApproval ? telegram : null);
	}

	stop(): void {
		this.poller.stop();
	}

	/** A task settled where it waits for a person. Never throws. */
	notify(event: NeedsYouEvent): void {
		try {
			const settings = this.projectNotificationSettings(event.projectId);
			if (!kindEnabled(event.kind, settings)) return;
			const language = getAppLanguage();
			this.showDesktop(event, message(event, language, true), settings.sound);
			void this.sendRemote(event, message(event, language));
		} catch (error) {
			appLog.warn("[NeedsYou] Notification failed", error);
		}
	}

	/** The task left the state a pending button was about. */
	revoke(taskId: string): void {
		this.approvals.revoke(taskId);
	}

	private showDesktop(event: NeedsYouEvent, text: { title: string; body: string }, sound: boolean): void {
		if (Notification.isSupported()) {
			const notification = new Notification({ title: text.title, body: text.body, silent: !sound });
			notification.on("click", () => {
				const window = this.mainWindow?.();
				if (!window) return;
				if (window.isMinimized()) window.restore();
				window.focus();
				window.webContents.send(IPC_CHANNELS.NEEDS_YOU_OPEN_TASK, event.taskId, event.projectId);
			});
			notification.show();
		}
		if (sound) shell.beep();
	}

	private async sendRemote(event: NeedsYouEvent, text: { title: string; body: string }): Promise<void> {
		const settings = this.appSettings();
		const ntfy = ntfyTarget(settings.needsYou, settings.globalNtfyAccessToken);
		const telegram = telegramTarget(settings.needsYou, settings.globalTelegramBotToken);
		const sends: Promise<boolean>[] = [];
		if (ntfy) sends.push(sendNtfy(ntfy, text.title, text.body));
		if (telegram) {
			const withButton =
				remotelyApprovable(event.kind) && settings.needsYou?.telegram?.remoteApproval === true;
			const approval = withButton
				? {
						token: this.approvals.issue(event.taskId, "approve_plan"),
						label: reply("approve", getAppLanguage()),
					}
				: undefined;
			sends.push(sendTelegram(telegram, text.title, text.body, approval));
		}
		const results = await Promise.allSettled(sends);
		for (const result of results) {
			if (result.status === "rejected" || !result.value) {
				// The reason may carry a URL with the bot token: log the kind only.
				appLog.warn(`[NeedsYou] A remote notification for task ${event.taskId} was not delivered`);
			}
		}
	}

	/**
	 * Apply a remote approval: the same two steps as the Approve button
	 * (submit the review, start the task), run by the renderer so that both
	 * paths are one. The task must still be waiting, checked at the press.
	 */
	private approvePlan(taskId: string): Promise<ApprovalOutcome> {
		if (!this.isAwaitingPlanApproval(taskId)) return Promise.resolve("notPending");
		const window = this.mainWindow?.();
		if (!window || window.isDestroyed()) return Promise.resolve("appClosed");
		const requestId = randomUUID();
		return new Promise<ApprovalOutcome>((resolve) => {
			const timer = setTimeout(() => {
				this.waiting.delete(requestId);
				resolve("appClosed");
			}, APPROVAL_REPLY_TIMEOUT_MS);
			this.waiting.set(requestId, (outcome) => {
				clearTimeout(timer);
				resolve(outcome);
			});
			window.webContents.send(IPC_CHANNELS.NEEDS_YOU_APPROVE_PLAN, requestId, taskId);
		});
	}

	private appSettings(): Partial<AppSettings> {
		return (readSettingsFile() ?? {}) as Partial<AppSettings>;
	}

	private projectNotificationSettings(projectId: string): NotificationSettings {
		const project = projectStore.getProjects().find((p) => p.id === projectId);
		return (
			project?.settings?.notifications ?? this.appSettings().notifications ?? DEFAULT_NOTIFICATIONS
		);
	}
}

export const notificationService = new NotificationService();
