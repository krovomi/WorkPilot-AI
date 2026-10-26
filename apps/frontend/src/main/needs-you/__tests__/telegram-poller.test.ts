import { describe, expect, it, vi } from "vitest";
import { ApprovalStore } from "../approvals";
import type { ApprovalOutcome } from "../telegram-poller";
import { TelegramApprovalPoller } from "../telegram-poller";

const target = { botToken: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjj", chatId: "42" };

function setup(outcome: ApprovalOutcome = "approved") {
	const approvals = new ApprovalStore();
	const approve = vi.fn(async (_taskId: string) => outcome);
	const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
	const poller = new TelegramApprovalPoller({ approvals, approve, reply: (key) => key, fetch });
	const calls = () =>
		fetch.mock.calls.map(([url, init]) => ({
			method: url.split("/").pop(),
			body: JSON.parse(String(init.body)),
		}));
	return { approvals, approve, poller, calls };
}

const press = (data: string, chat = 42, from = 42) => ({
	id: "cb1",
	from: { id: from },
	data,
	message: { message_id: 7, chat: { id: chat, type: "private" } },
});

describe("TelegramApprovalPoller.handle", () => {
	it("approves the named task once, answers, and removes the button", async () => {
		const { approvals, approve, poller, calls } = setup();
		const token = approvals.issue("t1", "approve_plan");
		await poller.handle(press(`approve:${token}`), target);
		expect(approve).toHaveBeenCalledWith("t1");
		expect(calls()[0]).toEqual({ method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "approved" } });
		expect(calls()[1].method).toBe("editMessageReplyMarkup");

		await poller.handle(press(`approve:${token}`), target);
		expect(approve).toHaveBeenCalledTimes(1);
		expect(calls()[2].body.text).toBe("expired");
	});

	it("ignores a press from anyone but the configured person, and keeps the token", async () => {
		const { approvals, approve, poller, calls } = setup();
		const token = approvals.issue("t1", "approve_plan");
		await poller.handle(press(`approve:${token}`, -100123, 42), target);
		await poller.handle(press(`approve:${token}`, 42, 99), target);
		expect(approve).not.toHaveBeenCalled();
		expect(calls().every((c) => c.body.text === "expired")).toBe(true);
		expect(approvals.consume(token)?.taskId).toBe("t1");
	});

	it("approves nothing for an unknown or malformed token", async () => {
		const { approve, poller } = setup();
		await poller.handle(press("approve:forged"), target);
		await poller.handle(press("something-else"), target);
		expect(approve).not.toHaveBeenCalled();
	});

	it("says so when the plan no longer waits", async () => {
		const { approvals, poller, calls } = setup("notPending");
		const token = approvals.issue("t1", "approve_plan");
		await poller.handle(press(`approve:${token}`), target);
		expect(calls()[0].body.text).toBe("notPending");
	});
});
