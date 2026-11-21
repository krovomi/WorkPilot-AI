/**
 * Two sessions side by side as one video (#347): the comparison page of both
 * sessions, masked, played step by step in both columns at once by the
 * backend (`apps/backend/replay/compare_page.py`, `video.py`), as WebM or MP4.
 */

import { Film } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ReplayVideoFormat } from "../../../shared/types/replay-share";
import { useReplayShareStore } from "../../stores/replay-share-store";
import { Button } from "../ui/button";

export const ReplayComparisonVideo: React.FC<{
	sessionAId: string;
	sessionBId: string;
}> = ({ sessionAId, sessionBId }) => {
	const { t } = useTranslation(["replay"]);
	const { recordingVideo, exportComparisonVideo } = useReplayShareStore(
		useShallow((s) => ({
			recordingVideo: s.recordingVideo,
			exportComparisonVideo: s.exportComparisonVideo,
		})),
	);
	const record = (format: ReplayVideoFormat) =>
		exportComparisonVideo(sessionAId, sessionBId, {
			stripReasoning: false,
			stripTokens: false,
			format,
		});

	return (
		<div className="flex flex-wrap items-center justify-end gap-2">
			<p className="text-xs text-muted-foreground mr-auto">
				{t("replay:share.video.compareHint")}
			</p>
			<Button
				variant="outline"
				size="sm"
				disabled={recordingVideo}
				onClick={() => record("webm")}
			>
				<Film className="h-4 w-4 mr-1" />
				{t(
					recordingVideo
						? "replay:share.video.recording"
						: "replay:share.video.exportCompare",
				)}
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={recordingVideo}
				onClick={() => record("mp4")}
			>
				{t("replay:share.video.exportCompareMp4")}
			</Button>
		</div>
	);
};
