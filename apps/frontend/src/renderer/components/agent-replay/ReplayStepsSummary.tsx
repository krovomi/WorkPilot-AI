/**
 * A model's summary of a replay's steps (#347), for a session whose model
 * left no thinking trace: the replay shows what was done, the summary says
 * it in a few lines. It is asked on demand of the default provider's fast
 * model (`apps/backend/replay/summary.py`), masked like an export, and kept
 * with the session, so it goes out with its exports. It is shown as text.
 */

import { Sparkles } from "lucide-react";
import type React from "react";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ReplaySessionFull } from "../../stores/agent-replay-store";
import { useReplayShareStore } from "../../stores/replay-share-store";
import { useSettingsStore } from "../../stores/settings-store";
import { ProviderContext } from "../ProviderContext";
import { Button } from "../ui/button";

/** Whether the model left a trace: a thinking step, or a step's reasoning. */
export function hasThinking(session: ReplaySessionFull): boolean {
	return session.steps.some(
		(step) => step.step_type === "agent_thinking" || Boolean(step.reasoning?.trim()),
	);
}

export const ReplayStepsSummary: React.FC<{ session: ReplaySessionFull }> = ({
	session,
}) => {
	const { t } = useTranslation(["replay"]);
	const chosen = useContext(ProviderContext)?.selectedProvider;
	const saved = useSettingsStore((s) => s.settings?.selectedProvider);
	const provider = chosen || (typeof saved === "string" ? saved : "");
	const { summarizing, summarize } = useReplayShareStore(
		useShallow((s) => ({ summarizing: s.summarizing, summarize: s.summarize })),
	);
	if (hasThinking(session)) return null;
	const summary = session.summary;
	const recording = session.status === "recording";
	const model = summary
		? [summary.provider, summary.model].filter(Boolean).join(" · ")
		: "";

	return (
		<section className="space-y-2" aria-label={t("replay:summary.title")}>
			<h3 className="text-sm font-semibold flex items-center gap-1">
				<Sparkles className="h-4 w-4" />
				{t("replay:summary.title")}
			</h3>
			{summary ? (
				<>
					<p className="whitespace-pre-wrap break-words text-sm">{summary.text}</p>
					<p className="text-xs text-muted-foreground">
						{t("replay:summary.writtenBy", { model: model || "?" })}
					</p>
				</>
			) : (
				<p className="text-xs text-muted-foreground">{t("replay:summary.none")}</p>
			)}
			{recording ? (
				<p className="text-xs text-muted-foreground">{t("replay:summary.recording")}</p>
			) : provider ? (
				<Button
					size="sm"
					variant="outline"
					disabled={summarizing}
					onClick={() => summarize(session.session_id, provider)}
				>
					{t(
						summarizing
							? "replay:summary.working"
							: summary
								? "replay:summary.again"
								: "replay:summary.ask",
						{ provider },
					)}
				</Button>
			) : (
				<p className="text-xs text-muted-foreground">{t("replay:summary.noProvider")}</p>
			)}
		</section>
	);
};
