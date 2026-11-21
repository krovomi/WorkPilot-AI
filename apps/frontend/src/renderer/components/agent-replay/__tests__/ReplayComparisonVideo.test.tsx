/**
 * Two replays side by side as one video, and a replay as an MP4 (#347): the
 * buttons send the format asked for and the app's language, and say what
 * came of it on the replay view's notice.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplayShareStore } from "../../../stores/replay-share-store";
import { ReplayComparisonVideo } from "../ReplayComparisonVideo";
import { ReplayShareButton, ReplayShareNotice } from "../ReplaySharing";

const api = {
	exportReplayVideo: vi.fn(),
	exportReplayComparisonVideo: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useReplayShareStore.setState({ recordingVideo: false, notice: null });
});

afterEach(cleanup);

describe("ReplayComparisonVideo", () => {
	it("records the two sessions side by side, as WebM or MP4", async () => {
		api.exportReplayComparisonVideo.mockResolvedValue({
			success: true,
			filePath: "/x/ab.webm",
			stepsPlayed: 3,
			stepsTotal: 3,
		});
		render(
			<>
				<ReplayComparisonVideo sessionAId="a1" sessionBId="b2" />
				<ReplayShareNotice />
			</>,
		);
		expect(screen.getByText(/played step by step next to each other/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Side-by-side video (WebM)" }));
		await waitFor(() =>
			expect(api.exportReplayComparisonVideo).toHaveBeenCalledWith("a1", "b2", {
				stripReasoning: false,
				stripTokens: false,
				format: "webm",
				language: "en",
			}),
		);
		expect(await screen.findByText(/\/x\/ab\.webm/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Side-by-side video (MP4)" }));
		await waitFor(() =>
			expect(api.exportReplayComparisonVideo).toHaveBeenLastCalledWith(
				"a1",
				"b2",
				expect.objectContaining({ format: "mp4" }),
			),
		);
	});

	it("is busy while a video records, and says when ffmpeg is missing", async () => {
		useReplayShareStore.setState({ recordingVideo: true });
		const { unmount } = render(<ReplayComparisonVideo sessionAId="a1" sessionBId="b2" />);
		expect(screen.getByRole("button", { name: "Recording the video…" })).toBeDisabled();
		unmount();
		useReplayShareStore.setState({ recordingVideo: false });
		api.exportReplayComparisonVideo.mockResolvedValueOnce({
			success: true,
			refused: "no_mp4_encoder",
		});
		await useReplayShareStore
			.getState()
			.exportComparisonVideo("a1", "b2", { stripReasoning: false, stripTokens: false });
		expect(useReplayShareStore.getState().notice).toEqual({
			tone: "info",
			key: "replay:share.video.refused.no_mp4_encoder",
		});
	});

	it("says why the comparison video failed", async () => {
		api.exportReplayComparisonVideo.mockResolvedValueOnce({ success: false, error: "video_failed" });
		await useReplayShareStore
			.getState()
			.exportComparisonVideo("a1", "b2", { stripReasoning: false, stripTokens: false });
		expect(useReplayShareStore.getState().notice?.key).toBe("replay:share.errors.video_failed");
	});
});

it("the share dialog exports an MP4 too", async () => {
	api.exportReplayVideo.mockResolvedValueOnce({ success: true, canceled: true });
	render(<ReplayShareButton sessionId="s1" />);
	fireEvent.click(screen.getByRole("button", { name: "Share" }));
	fireEvent.click(screen.getByRole("button", { name: "Export a video (MP4)" }));
	await waitFor(() =>
		expect(api.exportReplayVideo).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({ format: "mp4" }),
		),
	);
	expect(useReplayShareStore.getState().notice).toBeNull();
});
