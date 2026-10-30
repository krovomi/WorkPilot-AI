import { AlertTriangle, Check, GitPullRequest, ListChecks, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewLesson } from "../../../shared/types/learning-loop";
import {
	adoptReviewLesson,
	dismissReviewLesson,
	useLearningLoopStore,
} from "../../stores/learning-loop-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** Same cap as the backend (`MAX_RULE_CHARS`). */
const MAX_RULE_CHARS = 500;

/**
 * Rules learned from reviews (plan of 29 October, IA1).
 *
 * A review thread the PR follow-up fixed, or the feedback given with a
 * rejected plan, is a candidate. Nothing of it reaches an agent until the
 * person adopts it here, in the wording they choose; an adopted rule then
 * goes into every phase's prompt, and can be withdrawn the same way.
 */
export function ReviewLessonsSection({
	projectDir,
}: {
	readonly projectDir: string;
}) {
	const { t } = useTranslation(["learningLoop"]);
	const lessons = useLearningLoopStore((s) => s.lessons);
	const pending = lessons.filter((l) => l.status === "pending");
	const adopted = lessons.filter((l) => l.status === "adopted");

	if (pending.length === 0 && adopted.length === 0) return null;

	return (
		<section className="space-y-3" aria-label={t("learningLoop:lessons.title")}>
			<div>
				<h3 className="text-sm font-medium flex items-center gap-2">
					<ListChecks className="h-4 w-4 text-primary" />
					{t("learningLoop:lessons.title")}
				</h3>
				<p className="text-xs text-muted-foreground mt-1">
					{t("learningLoop:lessons.description")}
				</p>
			</div>

			{pending.length > 0 && (
				<div className="space-y-2">
					<h4 className="text-xs font-medium text-muted-foreground">
						{t("learningLoop:lessons.pending", { count: pending.length })}
					</h4>
					{pending.map((lesson) => (
						<PendingLesson
							key={lesson.id}
							lesson={lesson}
							projectDir={projectDir}
						/>
					))}
				</div>
			)}

			{adopted.length > 0 && (
				<div className="space-y-2">
					<h4 className="text-xs font-medium text-muted-foreground">
						{t("learningLoop:lessons.adopted", { count: adopted.length })}
					</h4>
					<ul className="space-y-1">
						{adopted.map((lesson) => (
							<li
								key={lesson.id}
								className="flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm"
							>
								<span className="min-w-0 break-words">{lesson.rule}</span>
								<Button
									variant="ghost"
									size="sm"
									className="h-7 shrink-0 text-xs"
									onClick={() => dismissReviewLesson(projectDir, lesson.id)}
								>
									{t("learningLoop:lessons.withdraw")}
								</Button>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

function PendingLesson({
	lesson,
	projectDir,
}: {
	readonly lesson: ReviewLesson;
	readonly projectDir: string;
}) {
	const { t } = useTranslation(["learningLoop"]);
	const [rule, setRule] = useState(lesson.text);
	const [busy, setBusy] = useState(false);
	const wording = rule.trim();

	const decide = async (action: () => Promise<boolean>) => {
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rounded-lg border p-3 space-y-2">
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<Badge variant="outline" className="gap-1">
					<GitPullRequest className="h-3 w-3" />
					{t(`learningLoop:lessons.sources.${lesson.source}`)}
				</Badge>
				{lesson.origin.author && <span>{lesson.origin.author}</span>}
				{lesson.origin.path && (
					<code className="truncate">{lesson.origin.path}</code>
				)}
				{lesson.origin.spec && <code>{lesson.origin.spec}</code>}
			</div>

			{lesson.flags.length > 0 && (
				<p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500">
					<AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
					{t("learningLoop:lessons.flagged", {
						flags: lesson.flags.join(", "),
					})}
				</p>
			)}

			<Textarea
				value={rule}
				onChange={(event) => setRule(event.target.value)}
				maxLength={MAX_RULE_CHARS}
				rows={2}
				className="text-sm"
				aria-label={t("learningLoop:lessons.ruleLabel")}
			/>

			<div className="flex justify-end gap-2">
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() => decide(() => dismissReviewLesson(projectDir, lesson.id))}
				>
					<X className="h-3.5 w-3.5 mr-1" />
					{t("learningLoop:lessons.dismiss")}
				</Button>
				<Button
					size="sm"
					disabled={busy || wording === ""}
					onClick={() =>
						decide(() => adoptReviewLesson(projectDir, lesson.id, wording))
					}
				>
					<Check className="h-3.5 w-3.5 mr-1" />
					{t("learningLoop:lessons.adopt")}
				</Button>
			</div>
		</div>
	);
}
