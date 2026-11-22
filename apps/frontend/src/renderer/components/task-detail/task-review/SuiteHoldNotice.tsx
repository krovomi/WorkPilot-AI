import { Clock, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Said above the merge while the task's full suite runs on the forge's CI
 * (`plan.ciSuite`, state `pending`): the merge waits for its verdict.
 */
export function SuiteHoldNotice({ webUrl }: { readonly webUrl?: string }) {
	const { t } = useTranslation(["tasks"]);
	return (
		<div
			className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 p-2 text-xs text-info"
			role="status"
		>
			<Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
			<span className="flex-1">{t("tasks:suitePlacement.mergeHeld")}</span>
			{webUrl ? (
				<button
					type="button"
					className="flex shrink-0 items-center gap-1 underline underline-offset-2"
					onClick={() => void globalThis.electronAPI.openExternal(webUrl)}
				>
					<ExternalLink className="h-3 w-3" />
					{t("tasks:suitePlacement.mergeHeldLink")}
				</button>
			) : null}
		</div>
	);
}
