import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useBrowserRecorderStore } from "@/stores/browser-recorder-store";
import { CharterButton } from "../charter";

/**
 * Asks for a name for the test and the proposed checks ranked (#387): the
 * provider's fast model when there is one, rules otherwise. The name lands in
 * the name field, which the person can still change.
 */
export function RecorderAssistButton({ projectPath }: { readonly projectPath: string }) {
	const { t } = useTranslation(["browserAgent"]);
	const { idle, hasSteps, assisting, source, assist } = useBrowserRecorderStore(
		useShallow((s) => ({
			idle: s.status === "idle",
			hasSteps: s.steps.length > 0,
			assisting: s.assisting,
			source: s.assistSource,
			assist: s.assist,
		})),
	);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<CharterButton
				size="sm"
				icon={Sparkles}
				disabled={!idle || !hasSteps || assisting}
				busy={assisting}
				onClick={() => assist(projectPath)}
			>
				{t("browserAgent:recorder.assist.start")}
			</CharterButton>
			{source && <span className="wp-meta">{t(`browserAgent:recorder.assist.${source}`)}</span>}
		</div>
	);
}
