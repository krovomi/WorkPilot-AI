/**
 * The findings the project's feedback removed from this review (#361):
 * nothing disappears without a trace.
 */

import { EyeOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LearnedSuppression } from "../../../../shared/types/review-feedback";
import { Button } from "../../ui/button";

export function LearnedSuppressionsNote({
	suppressions,
}: {
	suppressions: LearnedSuppression[];
}) {
	const { t } = useTranslation("common");
	const [open, setOpen] = useState(false);
	if (suppressions.length === 0) return null;
	return (
		<div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground space-y-2">
			<div className="flex items-center gap-2 flex-wrap">
				<EyeOff className="h-3.5 w-3.5 shrink-0" />
				<span className="flex-1">
					{t("prReview.feedback.suppressed", { count: suppressions.length })}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-xs"
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
				>
					{open ? t("prReview.feedback.hide") : t("prReview.feedback.show")}
				</Button>
			</div>
			<p>{t("prReview.feedback.suppressedHint")}</p>
			{open && (
				<ul className="space-y-1">
					{suppressions.map((item) => (
						<li key={`${item.id}-${item.file}-${item.line}`} className="break-words">
							<span className="font-medium text-foreground">{item.title}</span>{" "}
							<code className="bg-muted px-1 rounded">
								{item.file}:{item.line}
							</code>{" "}
							{t("prReview.feedback.rejectedCount", { count: item.rejections })}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
