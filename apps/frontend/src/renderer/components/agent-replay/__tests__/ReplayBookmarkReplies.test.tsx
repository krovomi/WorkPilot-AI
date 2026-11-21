/**
 * The discussion under a bookmark (#347): replies are listed as text, a
 * reader answers or removes one, and a session still recording takes none.
 * The store puts each change on the open session.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayBookmark } from "../../../../shared/types/replay-share";
import { type ReplaySessionFull, useAgentReplayStore } from "../../../stores/agent-replay-store";
import { useReplayShareStore } from "../../../stores/replay-share-store";
import { ReplayBookmarkReplies } from "../ReplayBookmarkReplies";

const api = {
	addReplayBookmarkReply: vi.fn(),
	removeReplayBookmarkReply: vi.fn(),
};

const mark = (extra: Partial<ReplayBookmark> = {}): ReplayBookmark => ({
	id: "b1",
	step_index: 1,
	note: "why?",
	author: "",
	created_at: 1,
	...extra,
});

const reply = (id: string, note: string, author = "") => ({ id, note, author, created_at: 2 });

function openSession(bookmarks: ReplayBookmark[], id = "s1") {
	useAgentReplayStore.setState({
		activeSession: { session_id: id, steps: [], bookmarks } as unknown as ReplaySessionFull,
	});
}

const replies = () =>
	useAgentReplayStore.getState().activeSession?.bookmarks?.find((b) => b.id === "b1")?.replies;

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useReplayShareStore.setState({ savingBookmark: false, notice: null });
	openSession([mark(), mark({ id: "b2" })]);
});

afterEach(cleanup);

describe("ReplayBookmarkReplies", () => {
	it("lists the replies as text, with their author or someone", () => {
		const bookmark = mark({
			replies: [reply("r1", "<b>agreed</b>", "Bob"), reply("r2", "no")],
		});
		render(<ReplayBookmarkReplies sessionId="s1" bookmark={bookmark} readOnly={false} />);
		expect(screen.getByRole("list", { name: "Replies" })).toBeInTheDocument();
		expect(screen.getByText("<b>agreed</b>")).toBeInTheDocument();
		expect(screen.getByText("Bob")).toBeInTheDocument();
		expect(screen.getByText("Someone")).toBeInTheDocument();
	});

	it("answers a bookmark and puts the reply on the open session", async () => {
		api.addReplayBookmarkReply.mockResolvedValueOnce({
			success: true,
			reply: reply("r9", "agreed"),
		});
		render(<ReplayBookmarkReplies sessionId="s1" bookmark={mark()} readOnly={false} />);
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		const send = screen.getByRole("button", { name: "Send" });
		expect(send).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "  agreed " } });
		fireEvent.click(send);
		await waitFor(() =>
			expect(api.addReplayBookmarkReply).toHaveBeenCalledWith("s1", "b1", { note: "agreed" }),
		);
		await waitFor(() => expect(replies()).toEqual([reply("r9", "agreed")]));
		expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
		const other = useAgentReplayStore.getState().activeSession?.bookmarks?.[1];
		expect(other?.replies).toBeUndefined();
	});

	it("keeps the text when the reply is refused, and says why", async () => {
		api.addReplayBookmarkReply.mockResolvedValueOnce({
			success: false,
			error: '{"detail": "too_many_replies"}',
		});
		render(<ReplayBookmarkReplies sessionId="s1" bookmark={mark()} readOnly={false} />);
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "more" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() =>
			expect(useReplayShareStore.getState().notice?.key).toBe(
				"replay:share.errors.too_many_replies",
			),
		);
		expect(screen.getByLabelText("Reply")).toHaveValue("more");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
	});

	it("removes a reply from the open session", async () => {
		openSession([mark({ replies: [reply("r1", "a"), reply("r2", "b")] })]);
		api.removeReplayBookmarkReply.mockResolvedValueOnce({ success: true });
		const bookmark = mark({ replies: [reply("r1", "a"), reply("r2", "b")] });
		render(<ReplayBookmarkReplies sessionId="s1" bookmark={bookmark} readOnly={false} />);
		fireEvent.click(screen.getAllByRole("button", { name: "Remove this reply" })[0]);
		await waitFor(() => expect(replies()?.map((r) => r.id)).toEqual(["r2"]));
		expect(api.removeReplayBookmarkReply).toHaveBeenCalledWith("s1", "b1", "r1");
	});

	it("says why a reply was not removed", async () => {
		api.removeReplayBookmarkReply.mockResolvedValueOnce({ success: false, error: "HTTP 404" });
		await useReplayShareStore.getState().removeReply("s1", "b1", "r1");
		expect(useReplayShareStore.getState().notice?.key).toBe("replay:share.errors.generic");
	});

	it("changes nothing on another open session", async () => {
		openSession([mark()], "other");
		api.addReplayBookmarkReply.mockResolvedValueOnce({ success: true, reply: reply("r", "x") });
		await useReplayShareStore.getState().addReply("s1", "b1", { note: "x" });
		expect(replies()).toBeUndefined();
	});

	it("offers no reply or removal on a session still recording", () => {
		const bookmark = mark({ replies: [reply("r1", "a")] });
		render(<ReplayBookmarkReplies sessionId="s1" bookmark={bookmark} readOnly />);
		expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Remove this reply" })).not.toBeInTheDocument();
	});
});
