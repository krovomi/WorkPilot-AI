import { readMessage, readRoomEvent, withMessage } from "../team/room";
import { knownBadges } from "../team/types";

const MESSAGE = { id: "m1", author_id: "u2", author: "Bob", message: "Hi", reply_to: "", at: "2026-11-27T09:00:00Z" };

describe("team room", () => {
	it("reads a stored message, and nothing that is not one", () => {
		expect(readMessage(MESSAGE)).toEqual({
			id: "m1",
			authorId: "u2",
			author: "Bob",
			message: "Hi",
			replyTo: null,
			at: "2026-11-27T09:00:00Z",
		});
		expect(readMessage({ id: "m1", message: "Hi", at: "t" })).toMatchObject({ authorId: "", author: "?" });
		expect(readMessage({ ...MESSAGE, reply_to: "m0" })?.replyTo).toBe("m0");
		expect(readMessage(null)).toBeNull();
		expect(readMessage([MESSAGE])).toBeNull();
		expect(readMessage({ ...MESSAGE, id: 7 })).toBeNull();
		expect(readMessage({ ...MESSAGE, message: "" })).toBeNull();
		expect(readMessage({ ...MESSAGE, message: "x".repeat(2001) })).toBeNull();
		expect(readMessage({ ...MESSAGE, at: undefined })).toBeNull();
	});

	it("reads the room's events, bounded, and leaves the board's alone", () => {
		const users = [{ id: "u1", name: "Ada" }, { id: "u2" }, { name: "no id" }, null];
		expect(readRoomEvent({ type: "presence", data: { users } })).toEqual({
			kind: "presence",
			members: [
				{ id: "u1", name: "Ada" },
				{ id: "u2", name: "?" },
			],
		});
		const many = Array.from({ length: 250 }, (_, i) => ({ ...MESSAGE, id: `m${i}` }));
		const history = readRoomEvent({ type: "chat_history", data: { messages: many } });
		expect(history?.kind === "history" && history.messages.map((m) => m.id).slice(0, 1)).toEqual(["m50"]);
		expect(readRoomEvent({ type: "chat_history", data: { messages: "no" } })).toEqual({ kind: "history", messages: [] });
		expect(readRoomEvent({ type: "chat_message", data: MESSAGE })).toMatchObject({ kind: "message" });
		expect(readRoomEvent({ type: "chat_message", data: {} })).toBeNull();
		expect(readRoomEvent({ type: "chat_rejected", data: { reason: "too_fast" } })).toEqual({
			kind: "rejected",
			reason: "too_fast",
		});
		expect(readRoomEvent({ type: "chat_rejected", data: { reason: "other" } })).toBeNull();
		expect(readRoomEvent({ type: "spec_updated", data: {} })).toBeNull();
	});

	it("adds a message once, and keeps the last 200", () => {
		const one = readMessage(MESSAGE);
		if (!one) throw new Error("unreadable");
		expect(withMessage([one], one)).toHaveLength(1);
		const many = Array.from({ length: 200 }, (_, i) => ({ ...one, id: `m${i}` }));
		const next = withMessage(many, { ...one, id: "last" });
		expect(next).toHaveLength(200);
		expect(next[0].id).toBe("m1");
		expect(next.at(-1)?.id).toBe("last");
	});

	it("keeps only the badges the app knows, in their order", () => {
		expect(knownBadges(["ten_reviews", "mystery", "first_delivery"])).toEqual(["first_delivery", "ten_reviews"]);
	});
});
