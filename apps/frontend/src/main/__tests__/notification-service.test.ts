import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const shown: { title: string; body: string }[] = [];

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
		removeHandler: (channel: string) => handlers.delete(channel),
	},
	Notification: class {
		static isSupported = () => true;
		constructor(private readonly options: { title: string; body: string }) {}
		on() {
			// Clicks are not exercised here.
		}
		show() {
			shown.push(this.options);
		}
	},
	shell: { beep: vi.fn() },
}));

let settings: Record<string, unknown> = {};
vi.mock("../settings-utils", () => ({ readSettingsFile: () => settings }));
vi.mock("../project-store", () => ({ projectStore: { getProjects: () => [] } }));
vi.mock("../app-language", () => ({ getAppLanguage: () => "en" }));
vi.mock("../app-logger", () => ({ appLog: { warn: vi.fn() } }));

const sendNtfy = vi.fn(async (..._args: unknown[]) => true);
const sendTelegram = vi.fn(async (..._args: unknown[]) => true);
vi.mock("../needs-you/channels", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../needs-you/channels")>();
	return {
		...actual,
		sendNtfy: (...args: unknown[]) => sendNtfy(...args),
		sendTelegram: (...args: unknown[]) => sendTelegram(...args),
	};
});

const { kindEnabled, notificationService } = await import("../notification-service");

const TOPIC = "workpilot-AbCdEfGhIjKlMnOpQrStUv";
const BOT = "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjj";
const ALL_ON = { onTaskComplete: true, onTaskFailed: true, onReviewNeeded: true, sound: false };
const event = (kind: "plan_review" | "failed" | "completed") => ({
	kind,
	taskId: "t1",
	projectId: "p1",
	taskTitle: "Add login",
	detail: "Traceback: /home/me/path",
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("kindEnabled", () => {
	it("maps each kind to the existing switch", () => {
		const only = (key: keyof typeof ALL_ON) => ({ ...ALL_ON, onTaskComplete: false, onTaskFailed: false, onReviewNeeded: false, [key]: true });
		expect(kindEnabled("completed", only("onTaskComplete"))).toBe(true);
		expect(kindEnabled("failed", only("onTaskComplete"))).toBe(false);
		expect(kindEnabled("failed", only("onTaskFailed"))).toBe(true);
		for (const kind of ["plan_review", "qa_rejected", "qa_unverified"] as const) {
			expect(kindEnabled(kind, only("onReviewNeeded"))).toBe(true);
			expect(kindEnabled(kind, only("onTaskComplete"))).toBe(false);
		}
	});
});

describe("notificationService", () => {
	let send: ReturnType<typeof vi.fn>;
	let awaiting: boolean;

	beforeEach(() => {
		shown.length = 0;
		sendNtfy.mockClear();
		sendTelegram.mockClear();
		awaiting = true;
		send = vi.fn();
		settings = {
			notifications: ALL_ON,
			needsYou: {
				ntfy: { enabled: true, topic: TOPIC },
				telegram: { enabled: true, chatId: "42", remoteApproval: true },
			},
			globalTelegramBotToken: BOT,
		};
		notificationService.initialize(
			() => ({ isDestroyed: () => false, webContents: { send } }) as never,
			() => awaiting,
		);
		notificationService.stop();
	});

	it("shows the error detail on the desktop only", async () => {
		notificationService.notify(event("failed"));
		await flush();
		expect(shown[0].body).toContain("Traceback");
		expect(String(sendNtfy.mock.calls[0][2])).not.toContain("Traceback");
		expect(String(sendTelegram.mock.calls[0][2])).not.toContain("Traceback");
		expect(sendTelegram.mock.calls[0][3]).toBeUndefined();
	});

	it("puts an approval button on a plan review only when remote approval is on", async () => {
		notificationService.notify(event("plan_review"));
		await flush();
		expect(sendTelegram.mock.calls[0][3]).toMatchObject({ label: "Approve the plan" });

		(settings.needsYou as { telegram: { remoteApproval: boolean } }).telegram.remoteApproval = false;
		notificationService.notify(event("plan_review"));
		await flush();
		expect(sendTelegram.mock.calls[1][3]).toBeUndefined();
	});

	it("respects a switched-off kind", async () => {
		settings.notifications = { ...ALL_ON, onTaskComplete: false };
		notificationService.notify(event("completed"));
		await flush();
		expect(shown).toHaveLength(0);
		expect(sendNtfy).not.toHaveBeenCalled();
	});

	it("tests each channel from the saved settings", async () => {
		const result = await handlers.get(IPC_CHANNELS.NEEDS_YOU_TEST)?.();
		expect(result).toEqual({ ntfy: "sent", telegram: "sent" });
		settings.needsYou = {};
		expect(await handlers.get(IPC_CHANNELS.NEEDS_YOU_TEST)?.()).toEqual({ ntfy: "off", telegram: "off" });
	});

	describe("a remote plan approval", () => {
		const approve = (taskId: string) =>
			(notificationService as unknown as { approvePlan(id: string): Promise<string> }).approvePlan(taskId);

		it("is refused when the plan no longer waits, without asking the renderer", async () => {
			awaiting = false;
			expect(await approve("t1")).toBe("notPending");
			expect(send).not.toHaveBeenCalled();
		});

		it("is applied by the renderer, which reports the outcome", async () => {
			const pending = approve("t1");
			expect(send).toHaveBeenCalledWith(IPC_CHANNELS.NEEDS_YOU_APPROVE_PLAN, expect.any(String), "t1");
			const requestId = send.mock.calls[0][1];
			await handlers.get(IPC_CHANNELS.NEEDS_YOU_APPROVAL_RESULT)?.({}, requestId, "approved");
			expect(await pending).toBe("approved");
		});

		it("never reads a made-up outcome as an approval", async () => {
			const pending = approve("t1");
			const requestId = send.mock.calls[0][1];
			await handlers.get(IPC_CHANNELS.NEEDS_YOU_APPROVAL_RESULT)?.({}, requestId, "yes please");
			expect(await pending).toBe("notPending");
		});
	});
});
