/**
 * Sharing a recorded agent session (#347): the export dialog, the import
 * button, the outcome notice, and the bookmarks of a session.
 *
 * Secrets and local folders are always masked before a file is written
 * (`apps/backend/replay/bundle.py`); the dialog only offers what may be taken
 * out on top. The video is that same masked page, played step by step by the
 * backend (`apps/backend/replay/video.py`). A bookmark note is Markdown and
 * is shown as text, and so are the replies under it.
 */

import { Bookmark, Download, Film, Share2, Trash2, Upload } from "lucide-react";
import type React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ReplaySessionFull, ReplayStep } from "../../stores/agent-replay-store";
import { useReplayShareStore } from "../../stores/replay-share-store";
import type { ReplayExportFormat } from "../../../shared/types/replay-share";
import { Notice } from "../charter";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ReplayBookmarkReplies } from "./ReplayBookmarkReplies";
import { ReplayTeamShareSection } from "./ReplayTeamShare";

const MAX_NOTE = 4000;

const NOTICE_TONES = { ok: "green", error: "red", info: "amber" } as const;

type Option = "stripReasoning" | "stripTokens" | "includeFileContents";
const OPTIONS: Option[] = ["stripReasoning", "stripTokens", "includeFileContents"];

export const ReplayShareButton: React.FC<{ sessionId: string }> = ({ sessionId }) => {
	const { t } = useTranslation(["replay"]);
	const [open, setOpen] = useState(false);
	const [options, setOptions] = useState<Record<Option, boolean>>({
		stripReasoning: false,
		stripTokens: false,
		includeFileContents: false,
	});
	const { exporting, exportSession, recordingVideo, exportVideo } = useReplayShareStore(
		useShallow((s) => ({
			exporting: s.exporting,
			exportSession: s.exportSession,
			recordingVideo: s.recordingVideo,
			exportVideo: s.exportVideo,
		})),
	);
	const busy = exporting || recordingVideo;
	const idPrefix = useId();

	const run = async (format: ReplayExportFormat) => {
		await exportSession(sessionId, { format, ...options });
		setOpen(false);
	};

	const record = async () => {
		await exportVideo(sessionId, {
			stripReasoning: options.stripReasoning,
			stripTokens: options.stripTokens,
		});
		setOpen(false);
	};

	return (
		<>
			<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
				<Share2 className="h-4 w-4 mr-1" />
				{t("replay:share.button")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("replay:share.title")}</DialogTitle>
						<DialogDescription>{t("replay:share.masked")}</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						{OPTIONS.map((option) => (
							<div key={option} className="flex items-start justify-between gap-4">
								<div>
									<Label htmlFor={`${idPrefix}-${option}`}>
										{t(`replay:share.options.${option}`)}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t(`replay:share.options.${option}Hint`)}
									</p>
								</div>
								<Switch
									id={`${idPrefix}-${option}`}
									checked={options[option]}
									onCheckedChange={(checked) =>
										setOptions((current) => ({ ...current, [option]: checked }))
									}
								/>
							</div>
						))}
					</div>
					<p className="text-xs text-muted-foreground">{t("replay:share.video.hint")}</p>
					<div className="flex flex-wrap justify-end gap-2 pt-2">
						<Button variant="outline" disabled={busy} onClick={record}>
							<Film className="h-4 w-4 mr-1" />
							{t(recordingVideo ? "replay:share.video.recording" : "replay:share.video.export")}
						</Button>
						<Button variant="outline" disabled={busy} onClick={() => run("html")}>
							{t("replay:share.exportPage")}
						</Button>
						<Button disabled={busy} onClick={() => run("wpreplay")}>
							<Download className="h-4 w-4 mr-1" />
							{t("replay:share.exportBundle")}
						</Button>
					</div>
					<ReplayTeamShareSection sessionId={sessionId} options={options} />
				</DialogContent>
			</Dialog>
		</>
	);
};

export const ReplayImportButton: React.FC = () => {
	const { t } = useTranslation(["replay"]);
	const { importing, importSession } = useReplayShareStore(
		useShallow((s) => ({ importing: s.importing, importSession: s.importSession })),
	);
	return (
		<Button variant="outline" size="sm" disabled={importing} onClick={() => importSession()}>
			<Upload className="h-4 w-4 mr-1" />
			{t("replay:share.import")}
		</Button>
	);
};

export const ReplayShareNotice: React.FC = () => {
	const { t } = useTranslation(["replay"]);
	const { notice, clearNotice } = useReplayShareStore(
		useShallow((s) => ({ notice: s.notice, clearNotice: s.clearNotice })),
	);
	if (!notice) return null;
	return (
		<Notice tone={NOTICE_TONES[notice.tone]} role="status">
			<span>{t(notice.key, notice.values)}</span>
			<Button variant="ghost" size="sm" className="ml-2" onClick={clearNotice}>
				{t("replay:share.dismiss")}
			</Button>
		</Notice>
	);
};

export const ReplayBookmarks: React.FC<{
	session: ReplaySessionFull;
	currentStep: ReplayStep | null;
	/** Moves the replay to a position in `session.steps`. */
	onGoTo: (position: number) => void;
}> = ({ session, currentStep, onGoTo }) => {
	const { t } = useTranslation(["replay"]);
	const [note, setNote] = useState("");
	const { savingBookmark, addBookmark, removeBookmark } = useReplayShareStore(
		useShallow((s) => ({
			savingBookmark: s.savingBookmark,
			addBookmark: s.addBookmark,
			removeBookmark: s.removeBookmark,
		})),
	);
	const bookmarks = session.bookmarks ?? [];
	const recording = session.status === "recording";

	const goTo = (stepIndex: number) => {
		const position = session.steps.findIndex((s) => s.step_index === stepIndex);
		if (position >= 0) onGoTo(position);
	};

	const save = async (target: ReplayStep) => {
		const saved = await addBookmark(session.session_id, {
			stepIndex: target.step_index,
			note: note.trim(),
		});
		if (saved) setNote("");
	};

	return (
		<section className="space-y-2" aria-label={t("replay:bookmarks.title")}>
			<h3 className="text-sm font-semibold flex items-center gap-1">
				<Bookmark className="h-4 w-4" />
				{t("replay:bookmarks.title")}
			</h3>
			{recording ? (
				<p className="text-xs text-muted-foreground">{t("replay:bookmarks.recording")}</p>
			) : (
				<div className="space-y-2">
					<Textarea
						value={note}
						maxLength={MAX_NOTE}
						onChange={(e) => setNote(e.target.value)}
						placeholder={t("replay:bookmarks.notePlaceholder")}
						aria-label={t("replay:bookmarks.note")}
						rows={2}
					/>
					{currentStep && (
						<Button
							size="sm"
							disabled={savingBookmark}
							onClick={() => save(currentStep)}
						>
							{t("replay:bookmarks.add", { step: currentStep.step_index })}
						</Button>
					)}
				</div>
			)}
			{bookmarks.length === 0 ? (
				<p className="text-xs text-muted-foreground">{t("replay:bookmarks.empty")}</p>
			) : (
				<ul className="space-y-2">
					{bookmarks.map((bookmark) => (
						<li
							key={bookmark.id}
							className="rounded-md border border-[var(--wp-border)] p-2 text-sm"
						>
							<div className="flex items-center justify-between gap-2">
								<Button
									variant="link"
									size="sm"
									className="px-0"
									onClick={() => goTo(bookmark.step_index)}
								>
									{t("replay:bookmarks.step", { step: bookmark.step_index })}
								</Button>
								{!recording && (
									<Button
										variant="ghost"
										size="sm"
										aria-label={t("replay:bookmarks.remove")}
										onClick={() => removeBookmark(session.session_id, bookmark.id)}
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								)}
							</div>
							{bookmark.author && (
								<p className="text-xs text-muted-foreground">{bookmark.author}</p>
							)}
							<p className="whitespace-pre-wrap break-words">{bookmark.note}</p>
							<ReplayBookmarkReplies
								sessionId={session.session_id}
								bookmark={bookmark}
								readOnly={recording}
							/>
						</li>
					))}
				</ul>
			)}
		</section>
	);
};
