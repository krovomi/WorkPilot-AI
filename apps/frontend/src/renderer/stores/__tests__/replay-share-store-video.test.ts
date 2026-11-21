/**
 * A replay as a video, and a model's summary of its steps (#347, lot 2): the
 * store sends the app's language, says what came of it as an i18n key (a
 * missing browser is an `info`, not an error) and puts a summary on the
 * open session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReplaySessionFull, useAgentReplayStore } from "../agent-replay-store";
import { failure, useReplayShareStore } from "../replay-share-store";

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
	exportReplayVideo: vi.fn(),
	summarizeReplaySession: vi.fn(),
};

const summary = { text: "- done", provider: "openai", model: "m", language: "en", created_at: 1 };

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	vi.stubGlobal("window", { electronAPI: api });
	i18nState.language = "en";
	useReplayShareStore.setState({ recordingVideo: false, summarizing: false, notice: null });
	useAgentReplayStore.setState({
		activeSession: { session_id: "s1", steps: [] } as unknown as ReplaySessionFull,
	});
});

describe("exportVideo", () => {
	it("sends the options in the app's language and says where it went", async () => {
		i18nState.language = "fr-FR";
		api.exportReplayVideo.mockResolvedValueOnce({
			success: true,
			filePath: "/x/a.webm",
			stepsPlayed: 4,
			stepsTotal: 4,
		});
		await useReplayShareStore
			.getState()
			.exportVideo("s1", { stripReasoning: true, stripTokens: false });
		expect(api.exportReplayVideo).toHaveBeenCalledWith("s1", {
			stripReasoning: true,
			stripTokens: false,
			language: "fr",
		});
		expect(useReplayShareStore.getState()).toMatchObject({
			recordingVideo: false,
			notice: {
				tone: "ok",
				key: "replay:share.video.saved",
				values: { path: "/x/a.webm", played: "4", total: "4" },
			},
		});
	});

	it("says when only part of the steps fit in the video", async () => {
		i18nState.language = undefined;
		api.exportReplayVideo.mockResolvedValueOnce({
			success: true,
			filePath: "/x/a.webm",
			stepsPlayed: 2,
			stepsTotal: 9,
		});
		await useReplayShareStore.getState().exportVideo("s1", { stripReasoning: false, stripTokens: false });
		expect(api.exportReplayVideo.mock.calls[0][1].language).toBe("en");
		expect(useReplayShareStore.getState().notice?.key).toBe("replay:share.video.savedPart");
	});

	it("a missing browser is information, not an error", async () => {
		api.exportReplayVideo.mockResolvedValueOnce({ success: true, refused: "no_browser" });
		await useReplayShareStore.getState().exportVideo("s1", { stripReasoning: false, stripTokens: false });
		expect(useReplayShareStore.getState().notice).toEqual({
			tone: "info",
			key: "replay:share.video.refused.no_browser",
		});
	});

	it("a closed dialog says nothing, a failure says why", async () => {
		api.exportReplayVideo.mockResolvedValueOnce({ success: true, canceled: true });
		await useReplayShareStore.getState().exportVideo("s1", { stripReasoning: false, stripTokens: false });
		expect(useReplayShareStore.getState()).toMatchObject({ recordingVideo: false, notice: null });
		api.exportReplayVideo.mockResolvedValueOnce({
			success: false,
			error: '{"detail":"video_timeout"}',
		});
		await useReplayShareStore.getState().exportVideo("s1", { stripReasoning: false, stripTokens: false });
		expect(useReplayShareStore.getState().notice).toEqual({
			tone: "error",
			key: "replay:share.errors.video_timeout",
		});
	});
});

describe("summarize", () => {
	it("asks the provider in lower case and puts the summary on the open session", async () => {
		api.summarizeReplaySession.mockResolvedValueOnce({ success: true, summary });
		await useReplayShareStore.getState().summarize("s1", " OpenAI ");
		expect(api.summarizeReplaySession).toHaveBeenCalledWith("s1", {
			provider: "openai",
			language: "en",
		});
		expect(useAgentReplayStore.getState().activeSession?.summary).toEqual(summary);
		expect(useReplayShareStore.getState().summarizing).toBe(false);
	});

	it("leaves another open session alone", async () => {
		api.summarizeReplaySession.mockResolvedValueOnce({ success: true, summary });
		await useReplayShareStore.getState().summarize("other", "claude");
		expect(useAgentReplayStore.getState().activeSession?.summary).toBeUndefined();
		useAgentReplayStore.setState({ activeSession: null });
		api.summarizeReplaySession.mockResolvedValueOnce({ success: true, summary });
		await useReplayShareStore.getState().summarize("s1", "claude");
		expect(useAgentReplayStore.getState().activeSession).toBeNull();
	});

	it("says why there is no summary", async () => {
		api.summarizeReplaySession.mockResolvedValueOnce({
			success: false,
			error: '{"detail":"summary_failed"}',
		});
		await useReplayShareStore.getState().summarize("s1", "claude");
		expect(useReplayShareStore.getState()).toMatchObject({
			summarizing: false,
			notice: { tone: "error", key: "replay:share.errors.summary_failed" },
		});
	});
});

it.each([
	"bad_target",
	"video_busy",
	"video_too_large",
	"video_failed",
	"recording",
	"has_thinking",
	"no_steps",
	"summary_empty",
])("%s has its own text", (code) => {
	expect(failure({ error: JSON.stringify({ detail: code }) }).key).toBe(
		`replay:share.errors.${code}`,
	);
});
