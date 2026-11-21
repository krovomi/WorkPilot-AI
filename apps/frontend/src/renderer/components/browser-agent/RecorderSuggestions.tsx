import { Check, Lightbulb, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useBrowserRecorderStore } from "@/stores/browser-recorder-store";
import { CharterButton, Panel } from "../charter";

/**
 * The checks the recorder proposes after an action (#387): a status, an alert
 * or a heading that showed up. Kept, a check becomes a step right after its
 * action; set aside, it is gone. Its text is page content, shown as text.
 */
export function RecorderSuggestions() {
	const { t } = useTranslation(["browserAgent"]);
	const { suggestions, steps, accept, dismiss } = useBrowserRecorderStore(
		useShallow((s) => ({
			suggestions: s.suggestions,
			steps: s.steps,
			accept: s.acceptSuggestion,
			dismiss: s.dismissSuggestion,
		})),
	);
	if (!suggestions.length) return null;
	return (
		<Panel>
			<h3 className="wp-kicker mb-1">{t("browserAgent:recorder.suggestions.title")}</h3>
			<p className="wp-meta mb-2">{t("browserAgent:recorder.suggestions.hint")}</p>
			<ul className="space-y-1.5" data-testid="recorder-suggestions">
				{suggestions.map((check) => {
					const action = steps.find((s) => s.id === check.after);
					return (
						<li key={check.id} className="flex items-center gap-2 text-sm">
							<Lightbulb className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
							<span className="min-w-0 truncate">
								{t("browserAgent:recorder.suggestions.check", { text: check.text })}
							</span>
							{action && (
								<span className="wp-meta shrink-0">
									{t("browserAgent:recorder.suggestions.after", {
										action: t(`browserAgent:recorder.kinds.${action.kind}`),
									})}
								</span>
							)}
							<span className="ml-auto flex shrink-0 items-center gap-1">
								<CharterButton size="sm" icon={Check} onClick={() => accept(check.id)}>
									{t("browserAgent:recorder.suggestions.keep")}
								</CharterButton>
								<button
									type="button"
									className="wp-muted rounded-md p-1 hover:text-foreground"
									onClick={() => dismiss(check.id)}
									title={t("browserAgent:recorder.suggestions.dismiss")}
									aria-label={t("browserAgent:recorder.suggestions.dismiss")}
								>
									<X className="h-3.5 w-3.5" aria-hidden="true" />
								</button>
							</span>
						</li>
					);
				})}
			</ul>
		</Panel>
	);
}
