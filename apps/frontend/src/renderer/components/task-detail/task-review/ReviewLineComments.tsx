/**
 * Line comments inside the guided review (F9): the comments of one file in
 * one group, a composer opened from the diff's gutter, and resolve / reopen.
 * The comments come from `useReviewComments`, shared by a context so the
 * dialog's file views do not thread them through every level.
 */
import { CheckCircle2, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewGroup } from "../../../../shared/types/review-groups";
import type { ReviewComment, ReviewCommentInput } from "../../../../shared/types/review-comments";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import type { DiffLineTarget } from "../../ui/diff-viewer";
import { Textarea } from "../../ui/textarea";

export interface ReviewCommentsApi {
	comments: ReviewComment[];
	error: string | null;
	add: (input: ReviewCommentInput) => Promise<boolean>;
	update: (id: string, action: "resolve" | "reopen" | "delete") => Promise<boolean>;
	/** Every commit a group shows: a comment on none of them belongs to "not committed". */
	versions: Set<string>;
}

export const ReviewCommentsContext = createContext<ReviewCommentsApi | null>(null);

/** The commit whose version of the file a line number of this group is in. */
export function groupVersion(group: ReviewGroup, side: "old" | "new"): string | undefined {
	return side === "old" ? group.from : group.to;
}

/** The comments shown on `path` in `group`. */
export function commentsFor(api: ReviewCommentsApi, group: ReviewGroup, path: string): ReviewComment[] {
	return api.comments.filter((c) => {
		if (c.path !== path) return false;
		if (group.kind === "uncommitted") return !api.versions.has(c.commit);
		return c.commit === groupVersion(group, c.side);
	});
}

const STATUS_VARIANT = {
	open: "warning",
	addressed: "info",
	resolved: "success",
	stale: "muted",
} as const;

export function FileComments({
	group,
	path,
	target,
	onCloseComposer,
}: {
	readonly group: ReviewGroup;
	readonly path: string;
	/** The line the person chose in the gutter; null: no composer open. */
	readonly target: DiffLineTarget | null;
	readonly onCloseComposer: () => void;
}) {
	const { t } = useTranslation(["taskReview"]);
	const api = useContext(ReviewCommentsContext);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	if (!api) return null;
	const comments = commentsFor(api, group, path);
	if (comments.length === 0 && !target) return null;

	const submit = async () => {
		if (!target || !text.trim()) return;
		setBusy(true);
		const ok = await api.add({
			path,
			side: target.side,
			line: target.line,
			text,
			commit: groupVersion(group, target.side),
		});
		setBusy(false);
		if (ok) {
			setText("");
			onCloseComposer();
		}
	};

	return (
		<div className="border-t border-border px-3 py-2 space-y-2">
			{comments.map((c) => (
				<div key={c.id} className="rounded border border-border p-2 text-xs space-y-1">
					<div className="flex items-center gap-2">
						<MessageSquare className="h-3 w-3 shrink-0" />
						<span className="font-mono">
							{t("taskReview:comments.where", { line: c.line })}
							{c.side === "old" ? ` ${t("taskReview:comments.removedLine")}` : ""}
						</span>
						<Badge variant={STATUS_VARIANT[c.status]}>{t(`taskReview:comments.status.${c.status}`)}</Badge>
						<span className="flex-1" />
						{c.status === "resolved" ? (
							<Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void api.update(c.id, "reopen")}>
								<RotateCcw className="h-3 w-3 mr-1" />
								{t("taskReview:comments.reopen")}
							</Button>
						) : (
							<Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void api.update(c.id, "resolve")}>
								<CheckCircle2 className="h-3 w-3 mr-1" />
								{t("taskReview:comments.resolve")}
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-2"
							aria-label={t("taskReview:comments.delete")}
							onClick={() => void api.update(c.id, "delete")}
						>
							<Trash2 className="h-3 w-3" />
						</Button>
					</div>
					<p className="whitespace-pre-wrap">{c.text}</p>
				</div>
			))}
			{target && (
				<div className="space-y-2">
					<label className="text-xs font-medium" htmlFor={`comment-${group.key}-${path}`}>
						{t("taskReview:comments.composerLabel", { line: target.line })}
					</label>
					<Textarea
						id={`comment-${group.key}-${path}`}
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={2}
						autoFocus
						placeholder={t("taskReview:comments.placeholder")}
					/>
					{api.error && (
						<p className="text-xs text-destructive">
							{t(`taskReview:comments.errors.${api.error}`, {
								defaultValue: t("taskReview:comments.errors.not_writable"),
							})}
						</p>
					)}
					<div className="flex gap-2 justify-end">
						<Button variant="ghost" size="sm" onClick={onCloseComposer}>
							{t("taskReview:comments.cancel")}
						</Button>
						<Button size="sm" disabled={busy || !text.trim()} onClick={() => void submit()}>
							{t("taskReview:comments.add")}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

/** The open comments the next "Request changes" sends, in the feedback panel. */
export function OpenCommentsSummary({ comments }: { readonly comments: ReviewComment[] }) {
	const { t } = useTranslation(["taskReview"]);
	const open = comments.filter((c) => c.status === "open");
	if (open.length === 0) return null;
	return (
		<div className="mb-3 rounded-md border border-border bg-background/50 p-2 text-xs">
			<p className="font-medium mb-1">{t("taskReview:comments.willBeSent", { count: open.length })}</p>
			<ul className="space-y-0.5">
				{open.map((c) => (
					<li key={c.id} className="truncate">
						<code>
							{c.path}:{c.line}
						</code>{" "}
						{c.text}
					</li>
				))}
			</ul>
		</div>
	);
}
