import { Check, FileText, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CharterButton, Chip, ModuleHeader } from "../charter";
import type { WizardStep } from "./hooks/useChangelog";

interface ChangelogHeaderProps {
	readonly step: WizardStep;
	readonly onRefresh: () => void;
}

const STEPS: ReadonlyArray<{ step: WizardStep; key: "select" | "generate" | "release" }> = [
	{ step: 1, key: "select" },
	{ step: 2, key: "generate" },
	{ step: 3, key: "release" },
];

/** The module band of the changelog: title, current step, the three steps. */
export function ChangelogHeader({ step, onRefresh }: ChangelogHeaderProps) {
	const { t } = useTranslation(["changelog", "navigation"]);
	const description = t(`changelog:steps.step${step}`);

	return (
		<ModuleHeader
			kicker={t("navigation:groups.planning")}
			title={t("changelog:title")}
			description={description}
			icon={FileText}
			tone="green"
			actions={
				<>
					{STEPS.map(({ step: s, key }) => (
						<Chip key={key} tone={s <= step ? "green" : "muted"} pressed={s === step} dot={false}>
							{s < step ? <Check className="h-3 w-3" aria-hidden="true" /> : <span>{s}</span>}
							{t(`changelog:stepLabels.${key}`)}
						</Chip>
					))}
					<CharterButton variant="ghost" icon={RefreshCw} onClick={onRefresh}>
						{t("changelog:actions.refresh")}
					</CharterButton>
				</>
			}
		/>
	);
}
