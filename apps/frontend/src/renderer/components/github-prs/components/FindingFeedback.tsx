/**
 * Accept / Reject / Not applicable on one review finding (#361), with an
 * optional reason from a closed list. Repeated rejections of a kind of
 * finding teach the reviewer to stop raising it on this project. On a server
 * project, a member's rejection is held until a maintainer approves it.
 */

import { Ban, Hourglass, ThumbsDown, ThumbsUp } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	REVIEW_FEEDBACK_NOTE_MAX,
	REVIEW_FEEDBACK_REASONS,
	type ReviewFeedbackInput,
	type ReviewFeedbackReason,
	type ReviewFeedbackVerdict,
} from "../../../../shared/types/review-feedback";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";

interface FindingFeedbackProps {
	findingId: string;
	verdict?: ReviewFeedbackVerdict;
	pending?: boolean;
	/** The rejection waits for a maintainer before the reviewer learns from it. */
	held?: boolean;
	onSubmit: (input: ReviewFeedbackInput) => Promise<boolean> | boolean;
}

const BUTTONS: Array<{
	verdict: ReviewFeedbackVerdict;
	icon: typeof ThumbsUp;
	labelKey: string;
	activeClass: string;
}> = [
	{
		verdict: "accepted",
		icon: ThumbsUp,
		labelKey: "prReview.feedback.accept",
		activeClass: "text-success border-success/50 bg-success/10",
	},
	{
		verdict: "rejected",
		icon: ThumbsDown,
		labelKey: "prReview.feedback.reject",
		activeClass: "text-destructive border-destructive/50 bg-destructive/10",
	},
	{
		verdict: "not_applicable",
		icon: Ban,
		labelKey: "prReview.feedback.notApplicable",
		activeClass: "text-muted-foreground border-border bg-muted",
	},
];

export function FindingFeedback({
	findingId,
	verdict,
	pending = false,
	held = false,
	onSubmit,
}: FindingFeedbackProps) {
	const { t } = useTranslation("common");
	const formId = useId();
	const [draft, setDraft] = useState<ReviewFeedbackVerdict | null>(null);
	const [reason, setReason] = useState<ReviewFeedbackReason | "">("");
	const [note, setNote] = useState("");

	const choose = async (choice: ReviewFeedbackVerdict) => {
		if (choice === "accepted") {
			setDraft(null);
			await onSubmit({ findingId, verdict: choice });
			return;
		}
		setDraft(choice);
	};

	const save = async (choice: ReviewFeedbackVerdict) => {
		const ok = await onSubmit({
			findingId,
			verdict: choice,
			reason: reason || null,
			note: note.trim() || undefined,
		});
		if (ok) {
			setDraft(null);
			setReason("");
			setNote("");
		}
	};

	return (
		<div className="ml-7 space-y-2">
			<fieldset
				className="flex items-center gap-1 flex-wrap"
				aria-label={t("prReview.feedback.groupLabel")}
			>
				{BUTTONS.map(({ verdict: choice, icon: Icon, labelKey, activeClass }) => {
					const active = (draft ?? verdict) === choice;
					return (
						<Button
							key={choice}
							type="button"
							variant="outline"
							size="sm"
							disabled={pending}
							aria-pressed={active}
							onClick={() => void choose(choice)}
							className={cn("h-7 px-2 text-xs", active && activeClass)}
						>
							<Icon className="h-3 w-3 mr-1" />
							{t(labelKey)}
						</Button>
					);
				})}
			</fieldset>

			{held && !draft && (
				<p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
					<Hourglass className="h-3 w-3" />
					{t("prReview.feedback.held")}
				</p>
			)}

			{draft && (
				<div className="flex items-end gap-2 flex-wrap">
					<div className="space-y-1">
						<label
							htmlFor={`${formId}-reason`}
							className="block text-xs text-muted-foreground"
						>
							{t("prReview.feedback.reasonLabel")}
						</label>
						<NativeSelect
							id={`${formId}-reason`}
							value={reason}
							onChange={(event) =>
								setReason(event.target.value as ReviewFeedbackReason | "")
							}
							className="h-8 text-xs"
						>
							<option value="">{t("prReview.feedback.noReason")}</option>
							{REVIEW_FEEDBACK_REASONS.map((value) => (
								<option key={value} value={value}>
									{t(`prReview.feedback.reasons.${value}`)}
								</option>
							))}
						</NativeSelect>
					</div>
					<div className="flex-1 min-w-[12rem] space-y-1">
						<label
							htmlFor={`${formId}-note`}
							className="block text-xs text-muted-foreground"
						>
							{t("prReview.feedback.noteLabel")}
						</label>
						<Input
							id={`${formId}-note`}
							value={note}
							maxLength={REVIEW_FEEDBACK_NOTE_MAX}
							placeholder={t("prReview.feedback.notePlaceholder")}
							onChange={(event) => setNote(event.target.value)}
							className="h-8 text-xs"
						/>
					</div>
					<Button
						type="button"
						size="sm"
						className="h-8 text-xs"
						disabled={pending}
						onClick={() => void save(draft)}
					>
						{t("prReview.feedback.save")}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 text-xs"
						onClick={() => setDraft(null)}
					>
						{t("prReview.feedback.cancel")}
					</Button>
				</div>
			)}
		</div>
	);
}
