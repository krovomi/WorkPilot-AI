/**
 * @vitest-environment jsdom
 *
 * The team room in the window: it follows the room it joined only, keeps the
 * chat (history replaces, new messages add and count as unread unless mine),
 * turns a mention of me into a notice, and keeps the person's settings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamChatMessage } from "../../../shared/types";
import {
	DEFAULT_COLLABORATION_SETTINGS,
	mentions,
	useCollaborationStore,
} from "../collaboration-store";

const api = {
	joinTeamRoom: vi.fn(async () => ({ success: true })),
	leaveTeamRoom: vi.fn(async () => ({ success: true })),
	sendTeamChat: vi.fn(async () => ({ success: true })),
	releaseCardClaim: vi.fn(async () => ({ success: false, error: "Only an owner" })),
};

function message(id: string, authorId: string, text = "hello"): TeamChatMessage {
	return { id, authorId, author: authorId.toUpperCase(), message: text, replyTo: "", at: "2026-11-02T10:00:00Z" };
}

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockClear();
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
	useCollaborationStore.getState().leave();
	useCollaborationStore.setState({ settings: { ...DEFAULT_COLLABORATION_SETTINGS } });
	localStorage.clear();
});

async function joined() {
	await useCollaborationStore.getState().join("p1");
	useCollaborationStore.getState().applyUpdate({
		kind: "state",
		projectId: "p1",
		live: true,
		me: { id: "me", name: "Ann Lee" },
		users: [{ id: "me", name: "Ann Lee" }],
		locks: [{ taskId: "server:p1:001-a", cardId: "001-a", userId: "bob", userName: "Bob" }],
	});
}

describe("collaboration store", () => {
	it("joins one room at a time and ignores another project's updates", async () => {
		await joined();
		expect(api.joinTeamRoom).toHaveBeenCalledWith("p1");
		expect(useCollaborationStore.getState().locks["server:p1:001-a"]?.userName).toBe("Bob");
		useCollaborationStore.getState().applyUpdate({
			kind: "chat",
			projectId: "p2",
			messages: [message("x", "bob")],
			replace: false,
		});
		expect(useCollaborationStore.getState().messages).toEqual([]);

		await useCollaborationStore.getState().join("p2");
		expect(api.leaveTeamRoom).toHaveBeenCalledWith("p1");
		expect(useCollaborationStore.getState().locks).toEqual({});
	});

	it("keeps the history, adds new messages once, and counts unread ones", async () => {
		await joined();
		const { applyUpdate } = useCollaborationStore.getState();
		applyUpdate({ kind: "chat", projectId: "p1", messages: [message("1", "bob")], replace: true });
		expect(useCollaborationStore.getState().unreadChatCount).toBe(0);
		applyUpdate({
			kind: "chat",
			projectId: "p1",
			messages: [message("2", "bob"), message("3", "me")],
			replace: false,
		});
		applyUpdate({ kind: "chat", projectId: "p1", messages: [message("2", "bob")], replace: false });
		const state = useCollaborationStore.getState();
		expect(state.messages.map((m) => m.id)).toEqual(["1", "2", "3"]);
		expect(state.unreadChatCount).toBe(1);
		state.setChatOpen(true);
		expect(useCollaborationStore.getState().unreadChatCount).toBe(0);
	});

	it("turns a mention of me into a notice, once", async () => {
		await joined();
		useCollaborationStore.getState().applyUpdate({
			kind: "chat",
			projectId: "p1",
			messages: [message("1", "bob", "@ann lee can you look?"), message("2", "bob", "@Ann Leeroy")],
			replace: false,
		});
		const notices = useCollaborationStore.getState().takeNotices();
		expect(notices).toEqual([
			expect.objectContaining({ kind: "mention", author: "BOB", message: "@ann lee can you look?" }),
		]);
		expect(useCollaborationStore.getState().takeNotices()).toEqual([]);
	});

	it("sends with the reply and says why a message did not go", async () => {
		await joined();
		const store = useCollaborationStore.getState();
		store.setReplyingTo(message("1", "bob"));
		expect(await store.sendMessage("  ok ")).toBe(true);
		expect(api.sendTeamChat).toHaveBeenCalledWith("p1", "ok", "1");
		expect(useCollaborationStore.getState().replyingTo).toBeNull();

		api.sendTeamChat.mockResolvedValueOnce({ success: false, error: "offline" } as never);
		expect(await store.sendMessage("again")).toBe(false);
		expect(useCollaborationStore.getState().sendError).toBe("offline");
		expect(await store.releaseLock("server:p1:001-a")).toBe("Only an owner");
	});

	it("keeps the settings on this computer, refusing what is not one", () => {
		useCollaborationStore.getState().updateSettings({ chatEnabled: false, conflictStrategy: "first_write_wins" });
		expect(JSON.parse(localStorage.getItem("workpilot.collaboration.settings") ?? "{}")).toMatchObject({
			chatEnabled: false,
			conflictStrategy: "first_write_wins",
		});
	});
});

describe("mentions", () => {
	it.each([
		["@Ann", true],
		["hi @ann, look", true],
		["@Annie", false],
		["Ann", false],
	])("%s mentions Ann: %s", (text, expected) => {
		expect(mentions(text, { id: "me", name: "Ann" })).toBe(expected);
	});
});
