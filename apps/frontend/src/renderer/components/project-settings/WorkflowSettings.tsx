import { useTranslation } from "react-i18next";
import type { ProjectSettings as ProjectSettingsType } from "../../../shared/types";
import { ProjectTestPlacementSettings } from "../suite-placement/ProjectTestPlacementSettings";
import { Separator } from "../ui/separator";
import { AutoSplitSettings } from "./AutoSplitSettings";
import { CrossReviewSettings } from "./CrossReviewSettings";
import { SettingsGroup, SwitchRow } from "./SettingsGroup";

/**
 * How a task of this project is built, in the order it happens: before the
 * code (spec, split), while coding (TDD), and the checks before the review
 * (verification, second engine, where the long suites run).
 */
export function WorkflowSettings({
	settings,
	setSettings,
}: {
	readonly settings: ProjectSettingsType;
	readonly setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
}) {
	const { t } = useTranslation(["settings"]);
	const setProject = (patch: Partial<ProjectSettingsType>) =>
		setSettings((previous) => ({ ...previous, ...patch }));
	const group = (key: string) => ({
		title: t(`projectSections.general.groups.${key}.title`),
		description: t(`projectSections.general.groups.${key}.description`),
	});

	return (
		<>
			<SettingsGroup {...group("planning")}>
				<AutoSplitSettings settings={settings} setSettings={setSettings} />
				<SwitchRow
					id="spec-by-example"
					label={t("projectSections.general.specByExample")}
					description={t("projectSections.general.specByExampleDescription")}
					checked={settings.specByExample ?? false}
					onCheckedChange={(checked) => setProject({ specByExample: checked })}
				/>
			</SettingsGroup>

			<Separator />

			<SettingsGroup {...group("coding")}>
				<SwitchRow
					id="tdd-mode"
					label={t("projectSections.general.tddMode")}
					description={t("projectSections.general.tddModeDescription")}
					checked={settings.tddMode ?? false}
					onCheckedChange={(checked) => setProject({ tddMode: checked })}
				/>
			</SettingsGroup>

			<Separator />

			<SettingsGroup {...group("checks")}>
				<SwitchRow
					id="verify-loop"
					label={t("projectSections.general.verifyLoop")}
					description={t("projectSections.general.verifyLoopDescription")}
					checked={settings.verifyLoop ?? true}
					onCheckedChange={(checked) => setProject({ verifyLoop: checked })}
				/>
				<ProjectTestPlacementSettings settings={settings} onChange={setProject} />
				<CrossReviewSettings settings={settings} setSettings={setSettings} />
			</SettingsGroup>
		</>
	);
}
