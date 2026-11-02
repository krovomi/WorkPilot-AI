/**
 * @vitest-environment jsdom
 *
 * The team of a server board on screen: the chat sends and shows messages as
 * text, a claim badge names its holder and says when the server refused to
 * release it, the conflict dialog keeps either version, and each notice
 * becomes a toast unless the settings turn it off.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const values = options ? Object.values(options).map(String) : [];
			return values.length > 0 ? `${key}(${values.join(",")})` : key;
		},
		i18n: { language: "en" },
	}),
}));

import {
	DEFAULT_COLLABORATION_SETTINGS,
	useCollaborationStore,
} from "../../../stores/collaboration-store";
import { toastOf } from "../CollaborationNotifications";
import { ConflictResolver } from "../ConflictResolver";
import { TaskLockBadge } from "../TaskLockBadge";
import { TeamChat } from "../TeamChat";

const api = {
	joinTeamRoom: vi.fn(async () => ({ success: true })),
	leaveTeamRoom: vi.fn(async () => ({ success: true })),
	sendTeamChat: vi.fn(async () => ({ success: true })),
	releaseCardClaim: vi.fn(async () => ({ success: false, error: "Only an owner" })),
};

beforeEach(async () => {
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
	Element.prototype.scrollIntoView = vi.fn();
	useCollaborationStore.getState().leave();
	useCollaborationStore.setState({ settings: { ...DEFAULT_COLLABORATION_SETTINGS } });
	await useCollaborationStore.getState().join("p1");
	useCollaborationStore.getState().applyUpdate({
		kind: "state",
		projectId: "p1",
		live: true,
		me: { id: "me", name: "Me" },
		users: [{ id: "me", name: "Me" }],
		locks: [{ taskId: "server:p1:001-a", cardId: "001-a", userId: "bob", userName: "Bob" }],
	});
});

afterEach(() => cleanup());

describe("TeamChat", () => {
	it("shows messages as text and sends what is typed", async () => {
		useCollaborationStore.getState().applyUpdate({
			kind: "chat",
			projectId: "p1",
			replace: true,
			messages: [
				{ id: "1", authorId: "bob", author: "Bob", message: "<b>hi</b>", replyTo: "", at: "2026-11-02T10:00:00Z" },
			],
		});
		useCollaborationStore.getState().setChatOpen(true);
		render(<TeamChat />);
		expect(screen.getByText("<b>hi</b>")).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText("chat.placeholder"), { target: { value: "hello team" } });
		fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
		await waitFor(() => expect(api.sendTeamChat).toHaveBeenCalledWith("p1", "hello team", ""));
	});

	it("stays closed until opened", () => {
		const { container } = render(<TeamChat />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("TaskLockBadge", () => {
	it("names the holder and says why a release was refused", async () => {
		render(<TaskLockBadge taskId="server:p1:001-a" />);
		fireEvent.click(screen.getByRole("button", { name: "locks.claimedBy(Bob)" }));
		fireEvent.click(await screen.findByRole("button", { name: /locks.forceRelease/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("locks.releaseFailed(Only an owner)");
		expect(api.releaseCardClaim).toHaveBeenCalledWith("server:p1:001-a");
	});

	it("shows nothing on an unclaimed card", () => {
		const { container } = render(<TaskLockBadge taskId="server:p1:002-b" />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ConflictResolver", () => {
	it("shows both versions and keeps the one chosen", () => {
		const keepMine = vi.fn();
		const keepTheirs = vi.fn();
		render(
			<ConflictResolver
				open
				conflicts={[{ field: "description", mine: "Mine", theirs: "Theirs" }]}
				onKeepMine={keepMine}
				onKeepTheirs={keepTheirs}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText("Mine")).toBeInTheDocument();
		expect(screen.getByText("Theirs")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "conflicts.keepTheirs" }));
		fireEvent.click(screen.getByRole("button", { name: "conflicts.keepMine" }));
		expect(keepTheirs).toHaveBeenCalledOnce();
		expect(keepMine).toHaveBeenCalledOnce();
	});
});

describe("toastOf", () => {
	const t = (key: string, options?: Record<string, unknown>) =>
		options ? `${key}(${Object.values(options).join(",")})` : key;
	const settings = { ...DEFAULT_COLLABORATION_SETTINGS };

	it("says what a teammate did, and stays quiet when turned off", () => {
		const joined = { seq: 1, kind: "activity" as const, activity: { type: "joined" as const, user: "Bob" } };
		expect(toastOf(joined, settings, t)?.title).toBe("notifications.userJoined(Bob)");
		expect(toastOf(joined, { ...settings, notifyUserJoinLeave: false }, t)).toBeNull();

		const failed = {
			seq: 2,
			kind: "activity" as const,
			activity: { type: "run_finished" as const, user: "Bob", card: "001-a", phase: "build", status: "failed" as const },
		};
		expect(toastOf(failed, settings, t)).toMatchObject({
			title: "notifications.run.failed(Bob,001-a)",
			variant: "destructive",
		});
		const mention = { seq: 3, kind: "mention" as const, author: "Bob", message: "@Me" };
		expect(toastOf(mention, { ...settings, notifyChatMentions: false }, t)).toBeNull();
	});
});

describe("leaving", () => {
	it("leaves the room and forgets it", () => {
		act(() => useCollaborationStore.getState().leave());
		expect(api.leaveTeamRoom).toHaveBeenCalledWith("p1");
		expect(useCollaborationStore.getState().projectId).toBe("");
	});
});
