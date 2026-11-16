/**
 * Sharing a replay (#347): the store keeps what runs and the last outcome as
 * an i18n key, and puts a saved bookmark on the open session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ReplaySessionFull,
	useAgentReplayStore,
} from "../agent-replay-store";
import { errorDetail, failure, useReplayShareStore } from "../replay-share-store";

const i18nState = vi.hoisted(() => ({ language: "en" as string | undefined }));
vi.mock("i18next", () => ({
	default: {
		t: (key: string) => key,
		get language() {
			return i18nState.language;
		},
	},
}));

const api = {
	exportReplaySession: vi.fn(),
	importReplaySession: vi.fn(),
	addReplayBookmark: vi.fn(),
	removeReplayBookmark: vi.fn(),
	listReplaySessions: vi.fn(),
};

const mark = (id: string, step: number, at = 1) => ({
	id,
	step_index: step,
	note: id,
	author: "",
	created_at: at,
});

const openSession = (bookmarks?: ReturnType<typeof mark>[]) =>
	({ session_id: "s1", steps: [], bookmarks }) as unknown as ReplaySessionFull;

const options = { format: "wpreplay" as const, stripReasoning: false, stripTokens: true, includeFileContents: false };

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	vi.stubGlobal("window", { electronAPI: api });
	i18nState.language = "en";
	useReplayShareStore.setState({
		exporting: false,
		importing: false,
		savingBookmark: false,
		notice: null,
	});
	useAgentReplayStore.setState({ activeSession: null, sessions: [] });
});

describe("errors", () => {
	it("reads the detail of a refusal, or keeps the text", () => {
		expect(errorDetail('{"detail":"too_large"}')).toBe("too_large");
		expect(errorDetail('{"detail":[1]}')).toBe('{"detail":[1]}');
		expect(errorDetail("plain")).toBe("plain");
	});

	it("names known codes, the stopped backend, and the rest", () => {
		expect(failure({ error: '{"detail":"not_a_bundle"}' }).key).toBe(
			"replay:share.errors.not_a_bundle",
		);
		expect(failure({ error: "x", unreachable: true }).key).toBe(
			"replay:errors.backendUnreachable",
		);
		expect(failure({ error: "boom" })).toEqual({
			tone: "error",
			key: "replay:share.errors.generic",
			values: { error: "boom" },
		});
	});
});

describe("export", () => {
	it("exports in the app's language and says where", async () => {
		i18nState.language = "fr-FR";
		api.exportReplaySession.mockResolvedValue({ success: true, filePath: "/o/r.wpreplay" });

		await useReplayShareStore.getState().exportSession("s1", options);

		expect(api.exportReplaySession).toHaveBeenCalledWith("s1", { ...options, language: "fr" });
		expect(useReplayShareStore.getState()).toMatchObject({
			exporting: false,
			notice: { tone: "ok", key: "replay:share.exported", values: { path: "/o/r.wpreplay" } },
		});
	});

	it("says nothing when the dialog is closed, and the error when it fails", async () => {
		i18nState.language = undefined;
		api.exportReplaySession.mockResolvedValueOnce({ success: true, canceled: true });
		await useReplayShareStore.getState().exportSession("s1", options);
		expect(api.exportReplaySession.mock.calls[0][1].language).toBe("en");
		expect(useReplayShareStore.getState().notice).toBeNull();

		api.exportReplaySession.mockResolvedValueOnce({ success: false, error: "boom" });
		await useReplayShareStore.getState().exportSession("s1", options);
		expect(useReplayShareStore.getState().notice?.tone).toBe("error");
	});
});

describe("import", () => {
	it("imports, says whose session it is and lists the sessions again", async () => {
		api.importReplaySession.mockResolvedValue({
			success: true,
			session: { session_id: "n1", agent_name: "Bot" },
		});
		api.listReplaySessions.mockResolvedValue({ success: true, sessions: [{ session_id: "n1" }] });

		await useReplayShareStore.getState().importSession();

		expect(useReplayShareStore.getState().notice).toEqual({
			tone: "ok",
			key: "replay:share.imported",
			values: { name: "Bot" },
		});
		expect(useAgentReplayStore.getState().sessions).toEqual([{ session_id: "n1" }]);
	});

	it("stays quiet when closed, and names a refusal", async () => {
		api.importReplaySession.mockResolvedValueOnce({ success: true, canceled: true });
		await useReplayShareStore.getState().importSession();
		expect(useReplayShareStore.getState()).toMatchObject({ importing: false, notice: null });

		api.importReplaySession.mockResolvedValueOnce({ success: false, error: "too_large" });
		await useReplayShareStore.getState().importSession();
		expect(useReplayShareStore.getState().notice?.key).toBe("replay:share.errors.too_large");
		expect(api.listReplaySessions).not.toHaveBeenCalled();
	});
});

describe("bookmarks", () => {
	it("puts a saved bookmark on the open session, in step order", async () => {
		useAgentReplayStore.setState({ activeSession: openSession([mark("late", 5)]) });
		api.addReplayBookmark.mockResolvedValue({ success: true, bookmark: mark("early", 1) });

		const saved = await useReplayShareStore.getState().addBookmark("s1", {
			stepIndex: 1,
			note: "early",
		});

		expect(saved).toBe(true);
		const ids = useAgentReplayStore.getState().activeSession?.bookmarks?.map((b) => b.id);
		expect(ids).toEqual(["early", "late"]);
	});

	it("orders two bookmarks of one step by time", async () => {
		useAgentReplayStore.setState({ activeSession: openSession([mark("second", 1, 9)]) });
		api.addReplayBookmark.mockResolvedValue({ success: true, bookmark: mark("first", 1, 2) });
		await useReplayShareStore.getState().addBookmark("s1", { stepIndex: 1, note: "" });
		const ids = useAgentReplayStore.getState().activeSession?.bookmarks?.map((b) => b.id);
		expect(ids).toEqual(["first", "second"]);
	});

	it("leaves another session alone and starts a list for an older one", async () => {
		api.addReplayBookmark.mockResolvedValue({ success: true, bookmark: mark("b", 0) });
		await useReplayShareStore.getState().addBookmark("other", { stepIndex: 0, note: "" });
		expect(useAgentReplayStore.getState().activeSession).toBeNull();

		useAgentReplayStore.setState({ activeSession: openSession(undefined) });
		await useReplayShareStore.getState().addBookmark("s1", { stepIndex: 0, note: "" });
		expect(useAgentReplayStore.getState().activeSession?.bookmarks).toHaveLength(1);
	});

	it("says why a bookmark was not saved", async () => {
		api.addReplayBookmark.mockResolvedValue({ success: false, error: "boom" });
		const saved = await useReplayShareStore.getState().addBookmark("s1", {
			stepIndex: 0,
			note: "",
		});
		expect(saved).toBe(false);
		expect(useReplayShareStore.getState()).toMatchObject({ savingBookmark: false });
		expect(useReplayShareStore.getState().notice?.tone).toBe("error");
	});

	it("removes a bookmark, or says why not", async () => {
		useAgentReplayStore.setState({ activeSession: openSession([mark("a", 0), mark("b", 1)]) });
		api.removeReplayBookmark.mockResolvedValueOnce({ success: true });
		await useReplayShareStore.getState().removeBookmark("s1", "a");
		const ids = useAgentReplayStore.getState().activeSession?.bookmarks?.map((b) => b.id);
		expect(ids).toEqual(["b"]);

		api.removeReplayBookmark.mockResolvedValueOnce({ success: false, error: "gone" });
		await useReplayShareStore.getState().removeBookmark("s1", "b");
		expect(useReplayShareStore.getState().notice?.values).toEqual({ error: "gone" });
	});

	it("clears the notice", () => {
		useReplayShareStore.setState({ notice: { tone: "ok", key: "k" } });
		useReplayShareStore.getState().clearNotice();
		expect(useReplayShareStore.getState().notice).toBeNull();
	});
});
